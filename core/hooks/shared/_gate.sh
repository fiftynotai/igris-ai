#!/bin/bash

# Description: The ONE project resolver for every Igris hook (TD-359), plus the
#              registration gate for the SHARED multi-CLI hooks (FR-212c).
#              The Igris hooks project GLOBALLY (one ~/.claude/settings.json
#              block, every project on the machine fires them). This helper is
#              the single source of truth for "which Igris project is this
#              directory?" and "is it a REGISTERED one?" — sourced by all 6
#              shared hooks, and by both git hooks (core/git-hooks/pre-commit,
#              commit-msg) through their symlink-following locator, so a
#              non-Igris project sees a clean NO-OP instead of the brief-gate /
#              session nudge / compaction side-effects.
#
# Usage: `source` this file, then call `igris_resolve_project <dir>`,
#        `is_registered_igris_project <dir>` and/or `igris_slug_valid <s>`.
#        Sourcing only DEFINES: the three functions, their private helpers
#        and the result globals below. It runs nothing, so it is safe under
#        `set -e` in every host script.
#
# ---------------------------------------------------------------------------
# igris_slug_valid <s>  (TD-510)
#   exit 0 iff <s> matches cli/src/lib/slug.ts SLUG_RE,
#   ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ — the ONE bash spelling of it, used by
#   the marker read below and by pre_tool_use.sh before its brain lookup
#   (test/project_slug_parity.test.bash G1 holds it to SLUG_RE).
#
# ---------------------------------------------------------------------------
# igris_resolve_project <dir>  (TD-359; the TypeScript twin is
#   resolveProjectIdentity in cli/src/lib/project-identity.ts — edit BOTH and
#   test/project_slug_parity.test.bash in one commit)
#
#   Sets the non-exported globals
#     _IGRIS_RES_SLUG    the project slug (never empty for a non-empty input)
#     _IGRIS_RES_SOURCE  marker | registry | git-main | basename
#     _IGRIS_RES_TOP     the realpath'd git toplevel of <dir>, or empty
#     _IGRIS_RES_MAIN    the realpath'd MAIN checkout of that repo, or empty
#     _IGRIS_RES_LOOKUP  the path the registry walk started from
#   Always returns 0 (safe under `set -e`, bash 3.2: no arrays, no ${x,,}).
#
#   Precedence:
#     0. dir_real = the JS realpathSync(<dir>), as in the TS twin (TD-510):
#        a relative <dir> is anchored at the PHYSICAL cwd (`pwd -P`, else
#        $PWD), the path is folded textually (_igris_res_lexical: `//`, `.`,
#        `..` never above `/`, a trailing slash), then `cd && pwd -P` (the
#        letter case kept as given); a path that does not resolve is walked
#        in that folded form.
#     1. git probe with the hook location variables (GIT_DIR, GIT_WORK_TREE,
#        GIT_INDEX_FILE, GIT_COMMON_DIR, ...) STRIPPED — a git hook runs with
#        them set. ONE rev-parse: top = --show-toplevel; prefix =
#        --show-prefix without its trailing slash (empty at the top);
#        common = --git-common-dir (absolute; a relative answer — git < 2.31
#        echoes the unknown --path-format flag — is resolved from
#        top/prefix); main = dirname(common) when it is named `.git`, else
#        top. Any failure (no git, a broken worktree gitdir) leaves top =
#        main = empty and falls through.
#        here = top + prefix in git (git's on-disk spelling, which a
#        mis-cased dir_real on a case-insensitive volume does not share),
#        dir_real outside git.
#     2. marker `.igris-project`: its first line, trimmed, matching
#        cli/src/lib/slug.ts SLUG_RE ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ (so
#        never `.`, `..`, `.hidden` or `-x`). Searched in here and each
#        ancestor up to and including top (then main/ when main != top);
#        outside git, in here and its ancestors, stopping BEFORE $HOME and /.
#        An invalid marker is skipped. -> marker.
#     3. registry: lookup = main + prefix in git, else here (a linked
#        worktree's directory maps onto the same directory of its main
#        checkout; in a main checkout this is the identity). ONE query over
#        every ancestor of lookup (`/` excluded): the deepest registered
#        ancestor wins, the lowest rowid breaks a duplicate path (the legacy
#        slug of a split repo owns the data). Raw string compare, no tilde
#        expansion. -> registry.
#     4. basename(main) -> git-main.
#     5. basename(here) -> basename: the documented last resort.
#   DB: $HOME/.igris/memory/knowledge.db, as every hook (MAINTAINING row 134).
#
# ---------------------------------------------------------------------------
# is_registered_igris_project <dir>  (FR-212c)
#   exit 0  -> the resolver answered `registry`, or `marker` naming a slug that
#              has a `projects` row -> REGISTERED. `_GATE_RESOLVED_SLUG` holds
#              the slug (callers that already paid for the walk read it).
#   exit 1  -> anything else: `git-main` and `basename` answers, an absent /
#              locked / erroring brain DB, no sqlite3, or an empty <dir>.
#
# FAIL-OPEN-TO-NO-OP POLARITY (operator-locked, FR-212c):
#   Every uncertainty resolves to "NOT registered" (exit 1) so the host hook
#   no-ops (allows the write / emits empty context). We NEVER block a non-Igris
#   project's work because the brain happens to be missing or locked. This is
#   the INVERSE of the brief-gate's fail-toward-deny posture — the registration
#   gate sits ABOVE the brief-gate and is strictly permissive on uncertainty.
#
# Why a real DB-row match (NOT a basename fallback): the resolver always names
# SOME slug, so an un-bootstrapped environment still has one. The registration
# gate must NOT count that — a git-main or basename answer would false-POSITIVE
# every random directory as "registered" and re-introduce the global-misfire
# the gate exists to prevent. Only a registry answer (or a marker naming a
# registered slug) counts. TD-359 widened what PASSES the gate in one way: a
# linked worktree OUTSIDE its registered main checkout's tree is now that
# project (it silently no-opped before, the brief gate included).
#
# SQL: every interpolated value is escaped with the UNQUOTED assignment
# `q=${x//\'/\'\'}` (MAINTAINING row 153: under /bin/bash 3.2 the double-quoted
# form keeps its backslashes and the query fails open).

# The slug of the matched registered project (empty until a hit).
_GATE_RESOLVED_SLUG=""

# igris_resolve_project outputs (see the header). Never IGRIS_PROJECT_*:
# IGRIS_PROJECT_DIR is an existing INPUT variable of the shared hooks.
_IGRIS_RES_SLUG=""
_IGRIS_RES_SOURCE=""
_IGRIS_RES_TOP=""
_IGRIS_RES_MAIN=""
_IGRIS_RES_LOOKUP=""
_IGRIS_RES_MARK=""
_IGRIS_RES_LEX=""

# _igris_res_lexical <abs> — sets _IGRIS_RES_LEX to the absolute path <abs>
# folded the way JS path.resolve folds it (TD-510): empty and `.` segments
# dropped, `..` pops one (never above `/`), no trailing slash, `/` when
# nothing is left. Textual only: nothing is looked up, so no `..` reaches
# `cd`, whose fallback to the kernel's chdir would climb out of a symlink's
# TARGET where the TS twin keeps the lexical path (parity T8d). Builtins
# only, no subshell; `local LC_ALL=C` keeps the cuts byte-wise. A path with
# no empty, `.` or `..` segment is already folded and returned as is, as
# every hook input is (measured 2026-11-18, /bin/bash 3.2.57: the loop costs
# ~0.55 ms a call on a 9-segment path; rung 0 with this check, +0.13-0.28 ms).
_igris_res_lexical() {
  local rest="$1" seg="" out="" LC_ALL=C
  case "$rest" in
    *//* | */ | */./* | */. | */../* | */..) ;;
    *) _IGRIS_RES_LEX="$rest"; return 0 ;;
  esac
  while [ -n "$rest" ]; do
    seg="${rest%%/*}"
    if [ "$seg" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
    if [ -z "$seg" ] || [ "$seg" = "." ]; then continue; fi
    if [ "$seg" = ".." ]; then out="${out%/*}"; continue; fi
    out="$out/$seg"
  done
  _IGRIS_RES_LEX="${out:-/}"
  return 0
}

# igris_slug_valid <s> — exit 0 iff <s> is a cli/src/lib/slug.ts SLUG_RE
# slug, ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$: an alphanumeric FIRST character
# (so never `.`, `..`, a hidden name or an option-shaped `-x` — a slug names
# ~/.igris/projects/<slug>/ and must not escape it), then letters, digits,
# dot, underscore, hyphen, 64 at most. The allowed characters are spelled
# out, not a range: a range is locale-collated and could admit a non-ASCII
# letter that the TS twin's regex refuses. `local LC_ALL=C` makes the match
# and `${#s}` byte-wise (the length is checked after the class, so it counts
# ASCII bytes only); the caller's LC_ALL comes back on return. Builtins only.
igris_slug_valid() {
  local s="$1" LC_ALL=C
  case "$s" in
    ''|[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789]*) return 1 ;;
    *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]*) return 1 ;;
  esac
  [ "${#s}" -le 64 ]
}

# _igris_res_read_marker <dir> — sets _IGRIS_RES_MARK to the valid slug in
# <dir>/.igris-project, or to empty (absent, unreadable or invalid). Valid is
# exactly igris_slug_valid (SLUG_RE).
# The trim is ASCII whitespace only (space, tab, CR, VT, FF), never
# `[:space:]`: that class is locale-dependent (under a UTF-8 locale it trims a
# no-break space the C locale keeps), and the TS twin trims the same five
# bytes. The line is the bytes before the first NUL or newline, as the TS twin
# cuts it. A line `read` gives that only on bash 3.2 (macOS /bin/bash), which
# ends the value at a NUL; bash 4.3+ skips NUL bytes and reads on (NEWS-4.3 p), so
# `abc` NUL `def` read as `abcdef` on Linux while the TS twin read `abc`
# (BR-120). So the read's delimiter is the NUL (`-d ''`, the same on every
# bash) and the newline is cut after it. A marker that no NUL ends returns 1
# at EOF (the usual case), hence `|| true`.
# The read is BOUNDED at 4096 bytes, cli/src/lib/project-identity.ts
# MARKER_LINE_MAX: a line that has not ended within 4095 bytes is refused, as
# in the TS twin. Unbounded, a 1 MiB marker cost 50 s or more per hook call
# (the unbuffered `-d ''` read and a quadratic cut); bounded, the cut sees at
# most 4096 bytes. `local LC_ALL=C` makes `read -n` and `${#…}` count BYTES on
# every bash; the caller's LC_ALL comes back on return. Builtins only: hooks
# run on every tool call (test/project_slug_parity.test.bash T3-T7c, M3).
_igris_res_read_marker() {
  local f="$1/.igris-project" line="" ws=$' \t\r\v\f' nl=$'\n' LC_ALL=C
  _IGRIS_RES_MARK=""
  [ -f "$f" ] || return 0
  IFS= read -r -d '' -n 4096 line 2>/dev/null < "$f" || true  # [[ BR-120 NUL READ ]]
  line="${line%%"$nl"*}"
  [ "${#line}" -lt 4096 ] || return 0
  line="${line#"${line%%[!$ws]*}"}"
  line="${line%"${line##*[!$ws]}"}"
  igris_slug_valid "$line" || return 0
  _IGRIS_RES_MARK="$line"
  return 0
}

igris_resolve_project() {
  local dir="$1" dir_real="" n="" probe="" top="" common="" main="" cur="" next=""
  local rest="" prefix="" here=""
  local home_real="" db="" in_list="" q="" hit="" nl='
'
  _IGRIS_RES_SLUG=""
  _IGRIS_RES_SOURCE=""
  _IGRIS_RES_TOP=""
  _IGRIS_RES_MAIN=""
  _IGRIS_RES_LOOKUP=""
  _IGRIS_RES_MARK=""
  [ -n "$dir" ] || dir="$PWD"

  # 0. Normalise (TD-150): a symlinked checkout resolves to its real path.
  #    TD-510, the JS realpathSync: anchor a relative input at the physical
  #    cwd, fold an absolute one, then realpath. One tagged line per half
  #    (parity M4a, M4b); either deleted leaves a working resolver.
  n="$dir"
  [ "${n#/}" != "$n" ] || n="$(pwd -P 2>/dev/null || printf '%s' "$PWD")/$n"  # [[ TD-510 ANCHOR ]]
  [ "${n#/}" = "$n" ] || { _igris_res_lexical "$n"; n="$_IGRIS_RES_LEX"; }  # [[ TD-510 LEXICAL ]]
  dir_real="$(CDPATH='' cd -- "$n" 2>/dev/null && pwd -P)" || dir_real=""
  [ -n "$dir_real" ] || dir_real="$n"

  # 1. Git probe. ONE rev-parse prints the toplevel, the prefix (the
  #    directory below the toplevel, `Sub/Deep/`, or an empty line at the
  #    top) and the common dir; the subshell strips the location variables a
  #    git hook exports and prints the toplevel REALPATH, the prefix without
  #    its trailing slash and the common-dir REALPATH, or nothing at all.
  #    Every in-git path below is built from git's spelling, never from
  #    dir_real's: on a case-insensitive volume `pwd -P` keeps a mis-cased
  #    spelling (`.../wt-x`) while git reports the on-disk one (`.../WT-X`),
  #    so subtracting top from dir_real skipped the translation (measured
  #    2026-11-18, bash 3.2.57, git 2.50.1, APFS). A relative common dir (git
  #    < 2.31 echoes the unknown --path-format flag) is resolved from
  #    top/prefix for the same reason. Keep the subshell free of `case` and
  #    of comments: bash 3.2 scans a command substitution for its closing
  #    paren and mis-reads a case pattern or an apostrophe in there.
  if command -v git >/dev/null 2>&1; then
    probe="$(
      unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR \
            GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX
      out="$(git -C "$dir_real" rev-parse --show-toplevel --show-prefix --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
      t="${out%%"$nl"*}"
      r="${out#*"$nl"}"
      p="${r%%"$nl"*}"
      c="${out##*"$nl"}"
      if [ -z "$t" ] || [ -z "$c" ] || [ "$t" = "$out" ] || [ "$p" = "$r" ]; then exit 0; fi
      t="$(CDPATH='' cd -- "$t" 2>/dev/null && pwd -P)" || exit 0
      if [ "${c#/}" = "$c" ]; then c="$t/$p$c"; fi
      c="$(CDPATH='' cd -- "$c" 2>/dev/null && pwd -P)" || exit 0
      printf '%s\n%s\n%s\n' "$t" "${p%/}" "$c"
    )" || probe=""
    top="${probe%%"$nl"*}"
    rest="${probe#*"$nl"}"
    prefix="${rest%%"$nl"*}"
    common="${rest#*"$nl"}"
    if [ -n "$probe" ] && [ "$top" != "$probe" ] && [ "$prefix" != "$rest" ] \
       && [ -n "$top" ] && [ -n "$common" ]; then
      if [ "${common##*/}" = ".git" ]; then
        main="${common%/*}"
        [ -n "$main" ] || main="/"
      else
        main="$top"
      fi
    else
      top=""
      main=""
      prefix=""
    fi
  fi
  _IGRIS_RES_TOP="$top"
  _IGRIS_RES_MAIN="$main"

  # here: the directory as the walks see it — top + prefix in git (git's
  # spelling), dir_real outside git (the input's spelling, as `pwd -P` gives
  # it; the TS twin's realpath keeps it the same way).
  here="$dir_real"
  if [ -n "$top" ]; then
    here="$top"
    [ -z "$prefix" ] || here="${top%/}/$prefix"
  fi

  # 3a. The registry walk's start. It is `here`, and the marked block below
  #     is the ONLY place it becomes main + prefix — the worktree translation
  #     (test/project_slug_parity.test.bash M1 deletes the block and proves a
  #     linked worktree then stops resolving).
  _IGRIS_RES_LOOKUP="$here"
  # [[ TD-359 TRANSLATE BEGIN ]] a linked worktree looks up its main checkout
  if [ -n "$top" ] && [ -n "$main" ]; then
    _IGRIS_RES_LOOKUP="$main"
    [ -z "$prefix" ] || _IGRIS_RES_LOOKUP="${main%/}/$prefix"
  fi
  # [[ TD-359 TRANSLATE END ]]

  # 2. Marker. In git the walk starts at top + prefix, so it reaches top
  #    exactly and never climbs above it.
  if [ -n "$top" ]; then
    cur="$here"
    while :; do
      _igris_res_read_marker "$cur"
      [ -z "$_IGRIS_RES_MARK" ] || break
      [ "$cur" != "$top" ] || break
      next="${cur%/*}"
      [ -n "$next" ] || next="/"
      [ "$next" != "$cur" ] || break
      cur="$next"
    done
    if [ -z "$_IGRIS_RES_MARK" ] && [ -n "$main" ] && [ "$main" != "$top" ]; then
      _igris_res_read_marker "$main"
    fi
  else
    if [ -n "${HOME:-}" ]; then
      home_real="$(CDPATH='' cd -- "$HOME" 2>/dev/null && pwd -P)" || home_real=""
      [ -n "$home_real" ] || home_real="$HOME"
    fi
    cur="$here"
    while [ -n "$cur" ] && [ "$cur" != "/" ] && [ "$cur" != "$home_real" ]; do
      _igris_res_read_marker "$cur"
      [ -z "$_IGRIS_RES_MARK" ] || break
      next="${cur%/*}"
      [ "$next" != "$cur" ] || break
      cur="$next"
    done
  fi
  if [ -n "$_IGRIS_RES_MARK" ]; then
    _IGRIS_RES_SLUG="$_IGRIS_RES_MARK"
    _IGRIS_RES_SOURCE="marker"
    return 0
  fi

  # 3b. Registry: one query over every ancestor of the lookup path.
  db="${HOME:-}/.igris/memory/knowledge.db"
  if [ -n "${HOME:-}" ] && [ -f "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
    cur="$_IGRIS_RES_LOOKUP"
    while [ -n "$cur" ] && [ "$cur" != "/" ]; do
      q=${cur//\'/\'\'}
      in_list="$in_list${in_list:+, }'$q'"
      next="${cur%/*}"
      [ "$next" != "$cur" ] || break
      cur="$next"
    done
    if [ -n "$in_list" ]; then
      # A hard sqlite error (corrupt / locked DB, no projects table) is "no
      # registered ancestor" — never surfaced, never blocking (FR-212c).
      hit="$(sqlite3 "$db" "SELECT slug FROM projects WHERE path IN ($in_list) ORDER BY length(path) DESC, rowid ASC LIMIT 1;" 2>/dev/null)" || hit=""
      if [ -n "$hit" ]; then
        _IGRIS_RES_SLUG="$hit"
        _IGRIS_RES_SOURCE="registry"
        return 0
      fi
    fi
  fi

  # 4. The repo's main checkout names an unregistered repo.
  if [ -n "$main" ] && [ -n "${main##*/}" ]; then
    _IGRIS_RES_SLUG="${main##*/}"
    _IGRIS_RES_SOURCE="git-main"
    return 0
  fi

  # 5. The last resort: the directory's own name (here: dir_real outside git).
  cur="$here"
  while [ "$cur" != "/" ] && [ "${cur%/}" != "$cur" ]; do
    cur="${cur%/}"
  done
  _IGRIS_RES_SLUG="${cur##*/}"
  _IGRIS_RES_SOURCE="basename"
  return 0
}

is_registered_igris_project() {
  local dir="$1" db="" q="" hit=""
  _GATE_RESOLVED_SLUG=""

  # Empty / unreadable dir -> not registered (fail-open: the host no-ops).
  [ -n "$dir" ] || return 1

  db="$HOME/.igris/memory/knowledge.db"

  # No sqlite3 or no brain DB -> NOT registered (fail-open). An un-bootstrapped
  # machine cannot have a registered project, and we must never block its work.
  if ! command -v sqlite3 >/dev/null 2>&1 || [ ! -f "$db" ]; then
    return 1
  fi

  igris_resolve_project "$dir"
  case "$_IGRIS_RES_SOURCE" in
    registry)
      _GATE_RESOLVED_SLUG="$_IGRIS_RES_SLUG"
      return 0
      ;;
    marker)
      # A marker is an override, not a registration: it passes the gate only
      # when the slug it names is a registered project.
      q=${_IGRIS_RES_SLUG//\'/\'\'}
      hit="$(sqlite3 "$db" "SELECT 1 FROM projects WHERE slug = '$q' LIMIT 1;" 2>/dev/null)" || hit=""
      if [ -n "$hit" ]; then
        _GATE_RESOLVED_SLUG="$_IGRIS_RES_SLUG"
        return 0
      fi
      ;;
  esac
  return 1
}
