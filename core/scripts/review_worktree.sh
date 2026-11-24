#!/bin/bash
# Description: Open and close a review worktree (TD-497). `/hunt` TESTING and
#              REVIEWING run every reviewer (sentinel, warden) through it;
#              FR-279 (`/do-lite`) and TD-501 are to call it the same way.
#
#              A reviewer with a shell in the shared working tree can stash,
#              reset or switch branches under other sessions, and a suite it
#              runs can open the live brain. `open` gives the reviewer a
#              throwaway copy of the change instead: a detached git worktree
#              of the caller's HEAD plus the claimed paths' current content,
#              and an env file that enters it with a temporary HOME and brain
#              dir. It records the state a reviewer must not change; `close`
#              compares that state, removes the worktree, and fails on any
#              change.
#
# Usage:
#   review_worktree.sh open --id <ID> [--link <rel>]... [--home-link <name>]... -- <path>...
#   review_worktree.sh close <REVIEW_ROOT>
#
# open, in order:
#   1. Validates the id ([A-Za-z0-9._-], 1 to 64 characters), each --link (a
#      repository-relative path; when its source exists in the caller's
#      checkout it must be gitignored there) and each --home-link (one path
#      segment, never .igris). A missing --link source is skipped with a NOTE.
#   2. Validates the path set with `scoped_commit.sh --dry-run`, from this
#      script's own directory, so the reviewed set obeys exactly the
#      close-commit rules. Its exits 1 and 2 pass through; nothing is created.
#   3. Creates $TMPDIR/igris-review-<ID>-XXXXXX outside the caller's checkout,
#      with a marker file, `.igris-review`, naming the root, the caller's
#      checkout and the id. Any later failure removes everything and exits 3.
#   4. Records in <root>/state/, before the worktree exists: the stash list,
#      the names under refs/heads and refs/tags, the caller's checked-out
#      branch (or DETACHED), and each claimed path's content in the caller's
#      tree (a blob hash, a link target, or ABSENT). Then adds a DETACHED
#      worktree of HEAD at <root>/wt, with hooks disabled for the checkout.
#      No ref is created; one that was would show at close.
#   5. Copies each claimed path from the caller's tree (`cp -pP`: the mode is
#      kept and a symlink is copied as a link), or deletes it where the caller
#      deleted it. A path that lies beyond a symlinked directory in HEAD is
#      refused (exit 1) before any directory is created for it. A path not in
#      HEAD gets an intent-to-add entry in the worktree's own index, so
#      `git diff HEAD` shows it.
#   6. Writes <root>/review.diff (`git diff --binary HEAD` in the worktree,
#      new claimed files included) and checks that it names exactly the set.
#   7. Links each --link source into the worktree, and each --home-link entry
#      of the real HOME into <root>/home.
#   8. Writes <root>/env.sh, POSIX, sourceable from bash, zsh or sh:
#        cd '<root>/wt' || return 1
#        export HOME='<root>/home' IGRIS_BRAIN_DIR='<root>/brain'
#        unset IGRIS_DB_PATH IGRIS_PIDS_DIR
#      IGRIS_DB_PATH and IGRIS_PIDS_DIR outrank IGRIS_BRAIN_DIR in the brain's
#      path resolution (brain-mcp-server/src/db.ts resolveDbPath,
#      stdio-lifecycle.ts pidsDir), so env.sh must never keep them.
#   9. Prints NOTE lines (untracked files beside the set that are not in it;
#      other review roots still open), then:
#        REVIEW_ROOT=<root>
#        REVIEW_DIR=<root>/wt
#        REVIEW_ENV=<root>/env.sh
#        REVIEW_DIFF=<root>/review.diff
#        paths: <n>
#
# close re-reads that state from the caller's checkout named in the marker
#   and prints one line per check, `unchanged` or `CHANGED` followed by
#   `  + <line>` / `  - <line>` detail: `stash:`, `refs:`, `head:`, `claimed:`.
#   Then `worktree: as-opened|differs` (informational: the worktree's diff
#   against HEAD versus review.diff, so an unreverted mutation shows), and
#   `removed: yes|no`. Refs are compared by NAME: a sibling's commit moves a
#   SHA, not a name, and is not a change. close never drops, pops or deletes
#   a stash entry or a ref, and never runs `git worktree prune`, which would
#   touch other sessions' worktree registrations.
#
# Limits, stated: the checks compare state, not actions. After an explicit
#   `cd` out of the worktree, a stash-then-pop, an index change or a soft
#   reset in the shared tree, or an edit to a shared-tree file outside the
#   claimed set, is not detected. Only a sandboxed worker whose working
#   directory is fixed to the worktree closes that. A sibling session that
#   creates a branch, a tag or a stash entry during the review shows as a
#   change; the +/- lines let the operator attribute it. A --link'd directory
#   is the caller's own, shared and writable: a suite run through it can
#   write into, say, the checkout's node_modules or cli/dist, and close does
#   not see it (the source is gitignored, so it is in no checked state).
#
# Exit codes:
#   open   0 opened; 1 refused, nothing left behind; 2 usage error, or not
#          inside a git work tree; 3 internal failure (what was created is
#          removed again)
#   close  0 nothing changed and the root is removed; 1 something CHANGED
#          (the root is still removed); 2 not a review root, nothing removed
#          (a second close lands here); 3 nothing changed, but the removal
#          is incomplete
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile.

set -u
LC_ALL=C
export LC_ALL
# Literal pathspecs for this script's own path lookups, set per call and never
# exported (the scoped_commit.sh convention). The caller's global pathspec
# settings are cleared: git refuses literal combined with any of them.
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
lgit() { GIT_LITERAL_PATHSPECS=1 git "$@"; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MARKER=.igris-review
NL='
'

die() { echo "review_worktree: $2" >&2; exit "$1"; }
note() { echo "NOTE: $*"; }
usage() {
  die 2 "usage: review_worktree.sh open --id <ID> [--link <rel>]... [--home-link <name>]... -- <path>...
       review_worktree.sh close <REVIEW_ROOT>"
}

# A repository-relative path in the plain spelling git prints.
rel_ok() {
  case "$1" in
    ''|/*|*"$NL"*) return 1 ;;
  esac
  case "/$1/" in
    */../*|*/./*|*//*) return 1 ;;
  esac
  return 0
}

# The worktree's diff against HEAD, in a fixed format whatever the caller's
# diff config says.
dgit() {
  git -C "${wt:?}" -c core.quotePath=false diff --no-color --no-ext-diff --no-renames \
    --src-prefix=a/ --dst-prefix=b/ "$@"
}

# --- state readers (open records them, close re-reads them) -----------------
stash_list() { git -C "${top:?}" stash list --format='%H %gs'; }

ref_names() {
  local out
  out="$(git -C "${top:?}" for-each-ref --format='%(refname)' refs/heads refs/tags)" || return 1
  [ -z "$out" ] || printf '%s\n' "$out" | sort
}

caller_head() { git -C "${top:?}" symbolic-ref -q HEAD || echo DETACHED; }

claimed_state() {
  local p f h
  while IFS= read -r p; do
    f="$top/$p"
    if [ -L "$f" ]; then
      printf '%s\tlink:%s\n' "$p" "$(readlink "$f")"
    elif [ -f "$f" ]; then
      h="$(git hash-object --no-filters -- "$f")" || return 1
      printf '%s\t%s\n' "$p" "$h"
    elif [ -e "$f" ]; then
      printf '%s\tnot-a-file\n' "$p"
    else
      printf '%s\tABSENT\n' "$p"
    fi
  done < "${root:?}/state/paths"
}

# --- open --------------------------------------------------------------------
root=""
wt=""
top=""
opened=0

# On any exit before the end of a successful open: remove what was created.
open_cleanup() {
  [ "$opened" -eq 1 ] && return 0
  [ -n "$root" ] || return 0
  case "$(basename "$root")" in igris-review-*) ;; *) return 0 ;; esac
  if [ -n "$top" ] && [ -n "$wt" ] && [ -e "$wt" ]; then
    git -C "${top:?}" worktree remove --force "$wt" >/dev/null 2>&1
  fi
  rm -rf "${root:?}"
}

cmd_open() {
  local id="" saw_sep=0 p rel h out rc line src dst parent want d f a
  local paths=() links=() home_links=() set_paths=()
  while [ $# -gt 0 ]; do
    if [ "$saw_sep" -eq 1 ]; then
      paths+=("$1"); shift; continue
    fi
    case "$1" in
      --id) [ $# -ge 2 ] || usage; id="$2"; shift 2 ;;
      --link) [ $# -ge 2 ] || usage; links+=("$2"); shift 2 ;;
      --home-link) [ $# -ge 2 ] || usage; home_links+=("$2"); shift 2 ;;
      --) saw_sep=1; shift ;;
      *) die 2 "unexpected argument '$1' (paths go after --)" ;;
    esac
  done

  case "$id" in
    ''|*[!A-Za-z0-9._-]*) die 2 "--id must be 1 to 64 characters from [A-Za-z0-9._-]" ;;
  esac
  [ "${#id}" -le 64 ] || die 2 "--id must be 1 to 64 characters from [A-Za-z0-9._-]"
  for rel in ${links[@]+"${links[@]}"}; do
    rel_ok "$rel" || die 2 "--link '$rel' must be a repository-relative path with no '.', '..' or empty segment"
  done
  for h in ${home_links[@]+"${home_links[@]}"}; do
    case "$h" in
      ''|.|..|.igris|*/*|*"$NL"*) die 2 "--home-link '$h' must be one path segment, never .igris" ;;
    esac
  done
  [ "${#paths[@]}" -gt 0 ] || die 1 "refusing to open: the path set is empty (name the brief's own paths after --)"
  for p in "${paths[@]}"; do
    case "$p" in *"$NL"*) die 1 "refusing to open: a path holds a newline" ;; esac
  done

  top="$(git rev-parse --show-toplevel 2>/dev/null)" || die 2 "not inside a git work tree"
  [ -n "$top" ] || die 2 "not inside a git work tree"
  cd "$top" || die 2 "cannot enter the repository root: $top"
  top="$(pwd -P)"
  case "$top" in *"$NL"*) die 2 "the repository root holds a newline" ;; esac

  # The set must be one the close commit would accept.
  [ -f "$SCRIPT_DIR/scoped_commit.sh" ] || die 3 "scoped_commit.sh not found beside this script ($SCRIPT_DIR)"
  out="$(bash "$SCRIPT_DIR/scoped_commit.sh" -m review --dry-run -- "${paths[@]}" 2>&1)"
  rc=$?
  case "$rc" in
    0) ;;
    1) printf '%s\n' "$out" >&2; die 1 "refusing to open: the path set is not a valid close set" ;;
    2) printf '%s\n' "$out" >&2; die 2 "scoped_commit.sh refused the call" ;;
    *) printf '%s\n' "$out" >&2; die 3 "scoped_commit.sh --dry-run failed (exit $rc)" ;;
  esac
  # Its `  XY <path>` lines carry the normalised, de-duplicated set.
  while IFS= read -r line; do
    case "$line" in
      "  "??" "*) set_paths+=("${line:5}") ;;
    esac
  done <<EOF
$out
EOF
  [ "${#set_paths[@]}" -gt 0 ] || die 3 "could not read the validated set from scoped_commit.sh"

  # A link source that exists must be gitignored: anything else is content
  # the review would read from the shared tree instead of its own copy.
  for rel in ${links[@]+"${links[@]}"}; do
    src="$top/$rel"
    if [ -e "$src" ] || [ -L "$src" ]; then
      git check-ignore -q -- "$rel" \
        || die 1 "refusing to link '$rel': it is not gitignored in $top"
    fi
  done

  local tmpbase="${TMPDIR:-/tmp}"
  tmpbase="${tmpbase%/}"
  [ -n "$tmpbase" ] || tmpbase=/tmp
  trap open_cleanup EXIT
  root="$(mktemp -d "$tmpbase/igris-review-$id-XXXXXX")" || { root=""; die 3 "mktemp failed under $tmpbase"; }
  root="$(cd "$root" && pwd -P)" || die 3 "cannot resolve the review root"
  case "$root" in
    *"'"*|*"$NL"*) die 1 "refusing to open: the review root '$root' holds a quote or newline (set TMPDIR elsewhere)" ;;
  esac
  case "$root/" in
    "$top"/*) die 1 "refusing to open: the review root '$root' is inside the checkout (set TMPDIR elsewhere)" ;;
  esac
  printf 'root=%s\ntop=%s\nid=%s\n' "$root" "$top" "$id" > "$root/$MARKER" || die 3 "cannot write the marker"
  mkdir -p "$root/state" "$root/home" "$root/brain" || die 3 "cannot create the state, home and brain dirs"
  printf '%s\n' "${set_paths[@]}" > "$root/state/paths" || die 3 "cannot write the path list"
  # The baseline is taken BEFORE the worktree is added, so a ref that open's
  # own `git worktree add` created would show at close as a change.
  stash_list > "$root/state/stash" || die 3 "cannot read the stash list"
  ref_names > "$root/state/refs" || die 3 "cannot read the ref names"
  caller_head > "$root/state/head" || die 3 "cannot read the caller's HEAD"
  claimed_state > "$root/state/claimed" || die 3 "cannot hash the claimed paths"

  wt="$root/wt"
  git -c core.hooksPath="$root/nohooks" worktree add --detach -q "$wt" HEAD >/dev/null 2>"$root/add.err" \
    || die 3 "git worktree add failed: $(cat "$root/add.err")"
  local wt_phys
  wt_phys="$(cd "$wt" && pwd -P)" || die 3 "cannot enter the worktree"

  for p in "${set_paths[@]}"; do
    src="$top/$p"
    dst="$wt/$p"
    parent="$(dirname "$p")"
    # Never create, write or delete through a symlinked directory in the
    # worktree. Checked BEFORE the mkdir: `mkdir -p` through a link in HEAD
    # creates its missing directories wherever the link points. The deepest
    # part of the parent that already exists must be a real directory at its
    # own physical place.
    a="$parent"
    while [ "$a" != . ] && [ ! -e "$wt/$a" ] && [ ! -L "$wt/$a" ]; do a="$(dirname "$a")"; done
    if [ "$a" = . ]; then want="$wt_phys"; else want="$wt_phys/$a"; fi
    if [ -L "$wt/$a" ] || { [ -d "$wt/$a" ] && [ "$(cd "$wt/$a" && pwd -P)" != "$want" ]; }; then
      die 1 "refusing to open: '$p' lies beyond a symbolic link in HEAD"
    fi
    if [ -e "$src" ] || [ -L "$src" ]; then
      mkdir -p "$wt/$parent" || die 3 "cannot create $wt/$parent"
    fi
    rm -f "$dst" || die 3 "cannot clear $dst"
    if [ -e "$src" ] || [ -L "$src" ]; then
      cp -pP "$src" "$dst" || die 3 "cannot copy $p into the worktree"
      if ! git -C "${wt:?}" cat-file -e "HEAD:$p" 2>/dev/null; then
        lgit -C "${wt:?}" add -N -- "$p" || die 3 "cannot mark $p intent-to-add in the worktree"
      fi
    fi
  done

  dgit --binary HEAD > "$root/review.diff" || die 3 "cannot write review.diff"
  local names wanted
  names="$(dgit --name-only -z HEAD | tr '\0' '\n' | sort)"
  wanted="$(printf '%s\n' "${set_paths[@]}" | sort)"
  [ "$names" = "$wanted" ] \
    || die 3 "self-check failed: review.diff names [${names//$NL/ }], the set is [${wanted//$NL/ }]"

  for rel in ${links[@]+"${links[@]}"}; do
    src="$top/$rel"
    if ! { [ -e "$src" ] || [ -L "$src" ]; }; then
      note "link source missing, skipped: $rel"; continue
    fi
    if [ -e "$wt/$rel" ] || [ -L "$wt/$rel" ]; then
      note "link target already exists in the worktree, skipped: $rel"; continue
    fi
    mkdir -p "$(dirname "$wt/$rel")" && ln -s "$src" "$wt/$rel" || die 3 "cannot link $rel"
  done
  for h in ${home_links[@]+"${home_links[@]}"}; do
    src="$HOME/$h"
    if ! { [ -e "$src" ] || [ -L "$src" ]; }; then
      note "home link source missing, skipped: $h"; continue
    fi
    ln -s "$src" "$root/home/$h" || die 3 "cannot link home entry $h"
  done

  {
    printf "cd '%s' || return 1\n" "$wt"
    printf "export HOME='%s/home' IGRIS_BRAIN_DIR='%s/brain'\n" "$root" "$root"
    printf 'unset IGRIS_DB_PATH IGRIS_PIDS_DIR\n'
  } > "$root/env.sh" || die 3 "cannot write env.sh"

  # Untracked files beside the set that are not in it: the review will not
  # see them (a new file the author forgot to claim).
  local dirs=""
  for p in "${set_paths[@]}"; do
    d="$(dirname "$p")"
    case "$NL$dirs$NL" in *"$NL$d$NL"*) continue ;; esac
    dirs="$dirs$NL$d"
    [ -d "$top/$d" ] || continue
    while IFS= read -r -d '' f; do
      [ "$(dirname "$f")" = "$d" ] || continue
      grep -qxF -- "$f" "$root/state/paths" && continue
      note "untracked beside the set, not reviewed: $f"
    done < <(lgit -C "${top:?}" ls-files -z --others --exclude-standard -- "$d" 2>/dev/null)
  done
  for d in "$tmpbase"/igris-review-*; do
    [ -f "$d/$MARKER" ] || continue
    [ "$(cd "$d" && pwd -P)" = "$root" ] && continue
    note "another review root is open: $d"
  done

  echo "REVIEW_ROOT=$root"
  echo "REVIEW_DIR=$wt"
  echo "REVIEW_ENV=$root/env.sh"
  echo "REVIEW_DIFF=$root/review.diff"
  echo "paths: ${#set_paths[@]}"
  opened=1
  exit 0
}

# --- close -------------------------------------------------------------------
changed=0

# check <label> <reader> — re-read one piece of state and compare it with the
# copy open recorded.
check() {
  local base="$root/state/$1" now="$root/state/$1.now"
  if ! "$2" > "$now" 2>/dev/null; then
    echo "$1: CHANGED (could not be re-read)"
    changed=1
    return 0
  fi
  if cmp -s "$base" "$now"; then
    echo "$1: unchanged"
    return 0
  fi
  echo "$1: CHANGED"
  changed=1
  sort "$base" > "$now.a"
  sort "$now" > "$now.b"
  comm -13 "$now.a" "$now.b" | sed 's/^/  + /'
  comm -23 "$now.a" "$now.b" | sed 's/^/  - /'
  return 0
}

cmd_close() {
  [ $# -eq 1 ] || usage
  local arg="$1" m_root rc
  not_root() { echo "review_worktree: not a review root: $arg" >&2; exit 2; }
  [ -n "$arg" ] && [ -d "$arg" ] || not_root
  root="$(cd "$arg" && pwd -P)" || not_root
  case "$(basename "$root")" in igris-review-*) ;; *) not_root ;; esac
  [ -f "$root/$MARKER" ] || not_root
  m_root="$(sed -n 's/^root=//p' "$root/$MARKER" | head -n 1)"
  [ -n "$m_root" ] && [ "$m_root" = "$root" ] || not_root
  top="$(sed -n 's/^top=//p' "$root/$MARKER" | head -n 1)"
  wt="$root/wt"

  if [ -n "$top" ] && git -C "$top" rev-parse --git-dir >/dev/null 2>&1; then
    check stash stash_list
    check refs ref_names
    check head caller_head
    check claimed claimed_state
  else
    echo "caller: CHANGED (the checkout '$top' cannot be read)"
    changed=1
  fi

  if [ -d "$wt" ] && dgit --binary HEAD 2>/dev/null | cmp -s - "$root/review.diff"; then
    echo "worktree: as-opened"
  else
    echo "worktree: differs"
  fi

  rc=1
  if [ -n "$top" ]; then
    git -C "$top" worktree remove --force "$wt" >/dev/null 2>&1
    rc=$?
  fi
  rm -rf "${root:?}"
  if [ "$rc" -eq 0 ] && [ ! -e "$root" ]; then
    echo "removed: yes"
  else
    echo "removed: no"
    [ "$rc" -eq 0 ] || echo "NOTE: git worktree remove failed for $wt; its registration may remain (check git worktree list)"
    [ "$changed" -eq 1 ] && exit 1
    exit 3
  fi
  [ "$changed" -eq 1 ] && exit 1
  exit 0
}

case "${1:-}" in
  open) shift; cmd_open "$@" ;;
  close) shift; cmd_close "$@" ;;
  *) usage ;;
esac
