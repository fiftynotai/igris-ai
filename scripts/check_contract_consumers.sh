#!/bin/bash
set -euo pipefail

# Description: FR-186 mechanical contract→consumer impact-checker.
#   Parses MAINTAINING.md (the maintained contract map), scans the staged
#   diff for deletions/renames of mapped contract tokens, and surfaces the
#   consumer list so the committer (or warden) can verify the sweep.
#
#   Layer: this is the MECHANICAL net (memory #400). It DETECTS that a mapped
#   contract moved; it does NOT judge whether the consumers were swept
#   correctly (that is warden's nuance layer / the §17 checklist row).
#
# Usage:
#   check_contract_consumers.sh                 # scan the staged diff (pre-commit)
#   check_contract_consumers.sh --paths a b c   # advisory: preview consumers of paths
#                                               # (SPACE-separated; a comma-joined
#                                               #  argument is a usage error)
#   check_contract_consumers.sh --map <file>    # override map location (tests)
#
# ---------------------------------------------------------------------------
# WHAT AN EXIT 0 ACTUALLY PROVES (TD-334 — read this before trusting it)
# ---------------------------------------------------------------------------
# Two independent verdicts come out of this script:
#
#   1. Token sweep — WARN only, never blocks. A renamed/deleted mapped contract
#      is usually intentional, so the checker informs; it does not veto.
#   2. Map self-consistency — HARD-FAIL (exit 1). Every consumer citation that
#      is recognised as a repo path must resolve, and its line ref must exist.
#
# Verdict 2 does not run in every mode, and that difference is the whole
# reason an exit 0 gets over-read:
#   * default (staged) mode runs it ONLY when MAINTAINING.md is itself staged.
#     With the map unstaged, exit 0 says NOTHING about map health. That gate is
#     right at commit time (the map WILL be staged then), but an interactive
#     pre-commit run is not the check a reader assumes.
#   * `--paths` mode ALWAYS runs it. That is the meaningful manual invocation.
#   Whenever verdict 2 runs it prints a `map citations: N validated / M skipped`
#   line, so an exit 0 is never a silent "the whole map is healthy".
#
# WHICH CITATIONS ARE VALIDATED (the Consumers column only — map column 3):
#   Every backtick-quoted token in a Consumers cell is classified. A token is
#   treated as a repo-path citation, and is therefore VALIDATED, when it
#     - contains a "/" (a slash-less token like `index.ts` or `handleBriefGet`
#       is either shorthand or an identifier, and the two are indistinguishable
#       from here), and
#     - uses only the path charset [A-Za-z0-9_./*{},+-], and
#     - is not rooted at "~" or "/" (those document runtime/external readers)
#       and does not start with ".." (a module-relative import specifier).
#   Everything else is SKIPPED and COUNTED, not silently dropped: prose, call
#   signatures (`buildBrainGraph(db, opts)`), JSON-schema pointers
#   (`$defs/surface_contract`), <angle-bracket> placeholders, placeholder line
#   refs like `handlers.ts:NN`, and `<other-repo>:<path>` citations.
#
#   BOTH citation forms are validated, not just one (before TD-334 the bare
#   form — the dominant one — was skipped entirely and the line half of the
#   other was never looked at):
#     `path/to/file.ts`         -> the path must resolve
#     `path/to/file.ts:148`     -> the path must resolve AND line 148 must exist
#     `file.ts:79-102`, `:900,1359` -> every number in the ref must exist
#
#   Resolution is repo-root first, then path-SUFFIX against `git ls-files`: the
#   map deliberately cites short forms (`pages/Graph.tsx`, `edges/traversal.ts`)
#   relative to a directory the row's own prose establishes. A citation passes
#   when some tracked file ends with it at a segment boundary. A token ending
#   in "/" is resolved the same way against tracked directories.
#
#   GLOBS ARE RESOLVED, NOT SKIPPED. A token containing "*" or "{" is brace-
#   and glob-expanded (`core/skills/*/SKILL.md`, `core/os/{conduct,standards}.md`)
#   and hard-fails when the expansion is empty or when a brace member is
#   missing — a glob that matches nothing is exactly the staleness worth
#   catching. "**" is not a bash-3.2 pattern, so a trailing "/**" is validated
#   as its directory.
#
#   GENERATED PATHS ARE SKIPPED. A citation git ignores (`cli/dist/...`) is not
#   validated: it does not exist on a clean checkout, so failing on it would
#   make the gate machine-dependent.
#
# LINE NUMBERS (TD-322, folded into TD-334) are validated in TWO TIERS, because
#   the two kinds of drift do not cost the same:
#     - a number GREATER than the file's line count (or < 1) is a HARD-FAIL:
#       the citation cannot be pointing at anything.
#     - a line that exists but is BLANK or a bare closing delimiter ("}", "];")
#       is a WARNING (exit 0). "Points at a construct" is a cheap proxy, not a
#       proof, so it informs rather than blocks.
#   Full symbol resolution is out of scope: this catches drift, it does not
#   type-check the map.
#
# Dependencies: git, grep, sed, awk (all POSIX-standard; no sqlite3/jq).
# Exit codes:
#   0 - clean, or consumers surfaced as a WARNING (default non-blocking case),
#       possibly with line-drift WARNINGs
#   1 - stale map (a consumer citation does not resolve, a glob matches
#       nothing, or a cited line number is out of range)
#   2 - usage error (unknown flag; --paths with no argument or with a
#       comma-joined argument)

# ---------------------------------------------------------------------------
# Dependency validation (coding_guidelines §3) — validate upfront.
# ---------------------------------------------------------------------------
check_deps() {
  local missing=""
  local dep
  for dep in git grep sed awk; do
    if ! command -v "$dep" >/dev/null 2>&1; then
      missing="$missing $dep"
    fi
  done
  if [ -n "$missing" ]; then
    echo "Error: required command(s) not found:$missing" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing.
# ---------------------------------------------------------------------------
MODE="staged"       # staged | paths
MAP_FILE=""         # resolved below
declare -a EXPLICIT_PATHS=()

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --paths)
        MODE="paths"
        shift
        while [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; do
          # TD-334: --paths is SPACE-separated. A comma-joined argument used to
          # be accepted and resolved to ONE nonexistent path, so the run
          # reported nothing and looked like a clean pass. Reject it loudly —
          # same defect class as the gaps this script's map check closes.
          case "$1" in
            *,*)
              echo "Error: --paths is SPACE-separated; the argument '$1' contains a comma." >&2
              echo "       Use: --paths a b c   (not: --paths a,b,c)" >&2
              echo "       A comma-joined argument resolves to one nonexistent path and makes the run silently vacuous." >&2
              exit 2
              ;;
          esac
          EXPLICIT_PATHS+=("$1")
          shift
        done
        ;;
      --map)
        if [ "$#" -lt 2 ]; then
          echo "Error: --map requires a file argument" >&2
          exit 2
        fi
        MAP_FILE="$2"
        shift 2
        ;;
      -h|--help)
        # Print the whole leading comment block (line 1 is the shebang, line 2
        # is `set`). A fixed line range goes stale the moment the header grows.
        awk 'NR == 1 { next }
             /^#/ { seen = 1; sub(/^#[[:space:]]?/, ""); print; next }
             seen { exit }' "$0"
        exit 0
        ;;
      *)
        echo "Error: unknown argument '$1'" >&2
        echo "Usage: $0 [--paths <p>...] [--map <file>]" >&2
        exit 2
        ;;
    esac
  done

  # TD-334: `--paths` with no argument is the other silently-vacuous
  # invocation — it validates the map but previews nothing, and reads as a
  # clean pass for a path the caller thinks they named.
  if [ "$MODE" = "paths" ] && [ "${#EXPLICIT_PATHS[@]}" -eq 0 ]; then
    echo "Error: --paths requires at least one path argument" >&2
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# Resolve the repo root and the map file.
# ---------------------------------------------------------------------------
resolve_paths() {
  if [ -z "${REPO_ROOT:-}" ]; then
    REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  fi
  if [ -z "$REPO_ROOT" ]; then
    echo "Error: not inside a git repository (and REPO_ROOT unset)" >&2
    exit 1
  fi
  if [ -z "$MAP_FILE" ]; then
    MAP_FILE="$REPO_ROOT/MAINTAINING.md"
  fi
  if [ ! -f "$MAP_FILE" ]; then
    # No map present → nothing to check. Fail-open (the map is optional in
    # consumer projects that have not adopted FR-186).
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Parse the map. Emits one record per (token) on stdout in the form:
#   <type>\t<token>\t<consumers-joined-by-;>
# Only rows in the "## The Map" table are parsed (rows beginning with `| ` and
# whose first cell, stripped of backticks, is non-empty and not a header/separator).
# A Contract cell may hold multiple tokens separated by ` / `; each becomes its
# own record carrying the shared consumer list.
# ---------------------------------------------------------------------------
parse_map() {
  awk '
    # Track whether we are inside the "## The Map" section.
    /^## The Map[[:space:]]*$/ { in_map = 1; next }
    /^## / { in_map = 0 }                       # any later H2 ends the table
    in_map == 0 { next }
    $0 !~ /^\|/ { next }                        # only table rows
    {
      # Split the markdown row on the pipe.
      n = split($0, cell, "|")
      # cell[1] is empty (leading pipe). Contract=cell[2], Type=cell[3],
      # Consumers=cell[4].
      contract = cell[2]; type = cell[3]; consumers = cell[4]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", contract)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", type)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", consumers)
      # Skip the header row and the separator row.
      if (contract == "Contract" || contract == "") next
      if (contract ~ /^-+$/ || contract ~ /^:?-+:?$/) next
      # Strip backticks from the type cell.
      gsub(/`/, "", type)
      # A contract cell may carry several `tok` / `tok` tokens. Pull out each
      # backtick-quoted run; if none, treat the whole stripped cell as one token.
      tcount = 0
      rest = contract
      while (match(rest, /`[^`]+`/)) {
        tok = substr(rest, RSTART + 1, RLENGTH - 2)
        rest = substr(rest, RSTART + RLENGTH)
        # A single backtick cell may itself contain " / "-joined tokens.
        m = split(tok, parts, " / ")
        for (i = 1; i <= m; i++) {
          p = parts[i]
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", p)
          if (p != "") { tcount++; print type "\t" p "\t" consumers }
        }
      }
      if (tcount == 0) {
        gsub(/`/, "", contract)
        if (contract != "") print type "\t" contract "\t" consumers
      }
    }
  ' "$MAP_FILE"
}

# ---------------------------------------------------------------------------
# Self-consistency (HARD-FAIL). See the "WHAT AN EXIT 0 ACTUALLY PROVES" block
# at the top of this file for the full contract; the short version:
#   - EVERY backticked token in a Consumers cell is classified, not just the
#     `path:line` form (TD-334 §A: the bare-path form is the dominant one and
#     used to be skipped outright).
#   - A token classified as a repo path must RESOLVE, and its line ref must be
#     in range (TD-334 §B / TD-322: line numbers used to be ignored entirely).
#   - Skipped tokens are counted and reported, so exit 0 carries a number
#     instead of reading as "the whole map is healthy".
# ---------------------------------------------------------------------------

# Index files, populated once per run by build_path_index.
CITE_FILE_INDEX=""
CITE_DIR_INDEX=""
# Set by citation_resolves() to the absolute path the citation resolved to.
RESOLVED=""
# Counters reported in the summary line.
CITE_VALIDATED=0
CITE_SKIPPED=0
CITE_LINEREFS=0
CITE_WARNS=0

# Called explicitly at the end of check_map_self_consistency — deliberately NOT
# from an EXIT trap. Installing any EXIT trap makes bash stop dying on SIGPIPE,
# so every `printf ... | grep -q` in token_hit() starts reporting
# "printf: write error: Broken pipe" once grep short-circuits. That is 30+ lines
# of noise in the pre-commit hook, which is worse than leaking two small temp
# files if the script is killed mid-run.
#
# THAT IS ONLY THE NOISY HALF, AND REMOVING THE TRAP DOES NOT FIX THE OTHER ONE.
# `token_hit()` is `printf | grep -q` under `set -euo pipefail`. grep -q
# short-circuits, printf dies of SIGPIPE, and pipefail turns that into a false
# "no match" EVEN WHEN GREP MATCHED — with or without a trap. Measured on a
# map-staged index: 331/330/333/334/332 mapped contracts across five runs where
# the true count is 367, i.e. ~36 consumer warnings silently dropped, a
# DIFFERENT subset each run. It is pre-existing (byte-identical at HEAD) and
# touches only scan(), which returns 0 unconditionally, so it can never change
# an exit code — but it means the WARN half under-reports by ~10%.
# TD-345 owns fixing it. Do not "fix" it here by re-adding a trap; that only
# restores the noise while leaving the silent drop exactly where it is.
cleanup_path_index() {
  [ -n "$CITE_FILE_INDEX" ] && rm -f "$CITE_FILE_INDEX"
  [ -n "$CITE_DIR_INDEX" ] && rm -f "$CITE_DIR_INDEX"
  CITE_FILE_INDEX=""
  CITE_DIR_INDEX=""
  return 0
}

# Build the tracked-file index and its directory projection. Tracked files (not
# a filesystem walk) so the index is identical on every clean checkout and does
# not pick up build output or node_modules.
build_path_index() {
  CITE_FILE_INDEX="$(mktemp "${TMPDIR:-/tmp}/ccc-files.XXXXXX")"
  CITE_DIR_INDEX="$(mktemp "${TMPDIR:-/tmp}/ccc-dirs.XXXXXX")"
  git -C "$REPO_ROOT" ls-files 2>/dev/null > "$CITE_FILE_INDEX" || true
  # Every directory prefix of every tracked file, with a trailing slash.
  awk -F/ '{ p = ""; for (i = 1; i < NF; i++) { p = p $i "/"; print p } }' \
    "$CITE_FILE_INDEX" | sort -u > "$CITE_DIR_INDEX"
}

# Is this token a citation of a path in THIS repo? See the header block for the
# rationale behind each rule. Pure bash — this runs on ~1.5k tokens, so a fork
# per rule would make the pre-commit hook visibly slow.
citation_is_repo_path() {
  local p="$1"
  case "$p" in
    "") return 1 ;;
    "~"*|/*) return 1 ;;      # runtime/external reader, not a repo file
    ..*) return 1 ;;          # module-relative import specifier (../../db.js)
    # Any character outside the path charset means prose, a call signature, a
    # schema pointer, a placeholder, or an <other-repo>:<path> citation.
    *[!A-Za-z0-9_./*{},+-]*) return 1 ;;
  esac
  # A slash-less token is shorthand or an identifier; the two cannot be told
  # apart here, so it is not a citation we can validate.
  case "$p" in
    */*) ;;
    *) return 1 ;;
  esac
  return 0
}

# Does git ignore this path? Only asked when a citation FAILED to resolve, so
# it costs at most a handful of forks per run.
path_is_git_ignored() {
  git -C "$REPO_ROOT" check-ignore -q -- "$1" 2>/dev/null
}

# Resolve a non-glob citation: repo-root first, then as a path suffix of a
# tracked file (or tracked directory, for a token ending in "/").
citation_resolves() {
  local p="$1" esc hit
  RESOLVED=""
  if [ -e "$REPO_ROOT/$p" ]; then
    RESOLVED="$REPO_ROOT/$p"
    return 0
  fi
  esc="$(escape_ere "$p")"
  case "$p" in
    */) hit="$(grep -m1 -xE "(.*/)?$esc" "$CITE_DIR_INDEX" || true)" ;;
    *)  hit="$(grep -m1 -xE "(.*/)?$esc" "$CITE_FILE_INDEX" || true)" ;;
  esac
  if [ -n "$hit" ]; then
    RESOLVED="$REPO_ROOT/$hit"
    return 0
  fi
  return 1
}

# Resolve a glob/brace citation. Fails when the expansion is empty (a glob that
# matches nothing) or when any expanded word is missing (a brace member that no
# longer exists). The `eval` is safe: citation_is_repo_path already restricted
# the token to [A-Za-z0-9_./*{},+-], so there is no whitespace, quote, `$`,
# backtick or `;` left in it to expand.
GLOB_MISS=""   # set by glob_resolves to the reason it failed
glob_resolves() {
  local pat="$1" out word count=0 missing=0
  GLOB_MISS=""
  # `**` is not a bash-3.2 pattern. A trailing "/**" means "this directory and
  # everything beneath it", so validate the directory; an interior "**" is
  # narrowed to a single "*".
  case "$pat" in
    */'**') pat="${pat%'**'}" ;;
  esac
  case "$pat" in
    *'**'*) pat="$(printf '%s' "$pat" | sed 's|\*\*|*|g')" ;;
  esac
  out="$(cd "$REPO_ROOT" && shopt -s nullglob && eval "printf '%s\n' $pat" 2>/dev/null || true)"
  while IFS= read -r word; do
    [ -n "$word" ] || continue
    count=$((count + 1))
    if [ ! -e "$REPO_ROOT/$word" ]; then
      missing=1
      GLOB_MISS="brace member '$word' does not exist"
    fi
  done <<EOF
$out
EOF
  if [ "$count" -eq 0 ]; then
    GLOB_MISS="matches nothing under $REPO_ROOT"
    return 1
  fi
  [ "$missing" -eq 0 ]
}

# Validate the line half of a citation. Out of range -> hard fail (return 1);
# blank / bare-closing-delimiter -> WARN (return 0, counter bumped).
check_line_ref() {
  local file="$1" ref="$2" citation="$3"
  local total num first="" content trimmed
  if [ ! -f "$file" ]; then
    echo "[contract-check] STALE MAP: consumer citation '$citation' has a line number but does not name a file." >&2
    return 1
  fi
  # `wc -l` counts newlines and undercounts a file with no trailing newline.
  total="$(awk 'END { print NR }' "$file")"
  # sed, not `tr '-,'` — a BSD tr reads a leading "-" as an option flag.
  for num in $(printf '%s' "$ref" | sed 's/[-,]/ /g'); do
    [ -n "$first" ] || first="$num"
    if [ "$num" -lt 1 ] || [ "$num" -gt "$total" ]; then
      echo "[contract-check] STALE MAP: consumer citation '$citation' names line $num, but that file has $total lines." >&2
      return 1
    fi
  done
  content="$(sed -n "${first}p" "$file")"
  # `read` with the default IFS trims leading and trailing whitespace.
  read -r trimmed <<EOF
$content
EOF
  if [ -z "$trimmed" ]; then
    echo "[contract-check] WARN: consumer citation '$citation' points at a BLANK line — line drift, re-point it." >&2
    CITE_WARNS=$((CITE_WARNS + 1))
  elif [ -z "$(printf '%s' "$trimmed" | tr -d '[]{}();,>')" ]; then
    echo "[contract-check] WARN: consumer citation '$citation' points at a bare closing delimiter ('$trimmed') — line drift, re-point it." >&2
    CITE_WARNS=$((CITE_WARNS + 1))
  fi
  return 0
}

check_map_self_consistency() {
  local bad=0
  local citation path lineref
  CITE_VALIDATED=0
  CITE_SKIPPED=0
  CITE_LINEREFS=0
  CITE_WARNS=0
  build_path_index
  while IFS= read -r citation; do
    # Split a trailing line ref: `:148`, `:79-102`, `:900,1359`. A placeholder
    # ref (`handlers.ts:NN`) does not match, so the token keeps its colon and
    # is skipped by the charset rule below — deliberately.
    if [[ "$citation" =~ ^(.+):([0-9]+([-,][0-9]+)*)$ ]]; then
      path="${BASH_REMATCH[1]}"
      lineref="${BASH_REMATCH[2]}"
    else
      path="$citation"
      lineref=""
    fi

    if ! citation_is_repo_path "$path"; then
      CITE_SKIPPED=$((CITE_SKIPPED + 1))
      continue
    fi

    case "$path" in
      *'*'*|*'{'*)
        # Glob / brace citation.
        if glob_resolves "$path"; then
          CITE_VALIDATED=$((CITE_VALIDATED + 1))
        elif path_is_git_ignored "$path"; then
          CITE_SKIPPED=$((CITE_SKIPPED + 1))
        else
          echo "[contract-check] STALE MAP: consumer citation '$citation' is a glob that does not resolve: $GLOB_MISS" >&2
          bad=1
        fi
        continue
        ;;
    esac

    if ! citation_resolves "$path"; then
      if path_is_git_ignored "$path"; then
        CITE_SKIPPED=$((CITE_SKIPPED + 1))
        continue
      fi
      echo "[contract-check] STALE MAP: consumer citation '$citation' names a file that does not exist: $REPO_ROOT/$path" >&2
      bad=1
      continue
    fi
    CITE_VALIDATED=$((CITE_VALIDATED + 1))

    if [ -n "$lineref" ]; then
      CITE_LINEREFS=$((CITE_LINEREFS + 1))
      check_line_ref "$RESOLVED" "$lineref" "$citation" || bad=1
    fi
  done < <(
    # Pull every backtick-quoted token out of the Consumers column. The single
    # quotes are deliberate — we match LITERAL backtick characters, not a shell
    # expansion. shellcheck SC2016 does not apply.
    # NOTE: column 3 is the Consumers cell. A bogus citation planted in the
    # Contract cell is NOT seen here, by design — only consumer citations are
    # sweep targets.
    # shellcheck disable=SC2016
    parse_map | cut -f3 | tr ';' '\n' \
      | grep -oE '`[^`]+`' | tr -d '`' | sort -u || true
  )
  cleanup_path_index
  # Always report the shape of the check, so an exit 0 carries a number.
  echo "[contract-check] map citations: $CITE_VALIDATED validated ($CITE_LINEREFS with line refs), $CITE_SKIPPED skipped (not a repo path, external, or generated), $CITE_WARNS line-drift warning(s)." >&2
  return "$bad"
}

# ---------------------------------------------------------------------------
# Build the list of "changed tokens" to test against the map.
#   staged mode: removed diff lines (git diff --cached -U0, lines starting "-")
#                plus deleted/renamed paths (--diff-filter=DR).
#   paths  mode: the explicit --paths arguments (advisory preview).
# ---------------------------------------------------------------------------
REMOVED_LINES=""
CHANGED_PATHS=""

collect_changes() {
  if [ "$MODE" = "paths" ]; then
    local p
    for p in "${EXPLICIT_PATHS[@]:-}"; do
      [ -n "$p" ] && CHANGED_PATHS="$CHANGED_PATHS"$'\n'"$p"
    done
    return 0
  fi
  # staged mode
  # Removed lines: drop the diff "---" file header and the leading "-".
  REMOVED_LINES="$(git -C "$REPO_ROOT" diff --cached -U0 2>/dev/null \
    | grep -E '^-' | grep -vE '^---' | sed -E 's/^-//' || true)"
  # Deleted/renamed paths.
  CHANGED_PATHS="$(git -C "$REPO_ROOT" diff --cached --name-status --diff-filter=DR 2>/dev/null \
    | awk '{ for (i = 2; i <= NF; i++) print $i }' || true)"
}

# Is MAINTAINING.md itself in the staged set (any status)?
map_is_staged() {
  git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null \
    | grep -qxF "MAINTAINING.md"
}

# ---------------------------------------------------------------------------
# Match a single mapped token against the collected changes.
#   file        -> path literal: token appears in CHANGED_PATHS, or as a
#                  substring of a removed line.
#   others      -> anchored / word-boundary identifier match in removed lines
#                  (avoids `phase` matching `phaseout`).
# Returns 0 (match) / 1 (no match).
# ---------------------------------------------------------------------------
token_hit() {
  local type="$1" token="$2"
  case "$type" in
    file)
      # Path literal in the delete/rename set.
      if [ -n "$CHANGED_PATHS" ] && printf '%s\n' "$CHANGED_PATHS" \
          | grep -qF -- "$token"; then
        return 0
      fi
      # Or a removed diff line referencing the path literal.
      if [ -n "$REMOVED_LINES" ] && printf '%s\n' "$REMOVED_LINES" \
          | grep -qF -- "$token"; then
        return 0
      fi
      ;;
    *)
      # Identifier types (column / env-var / config-key / protocol / line-range):
      # anchored word-boundary match in removed lines. grep -w treats `.`/`_`/
      # `-` per the locale; for dotted/dashed identifiers we anchor on the
      # surrounding non-identifier char set explicitly.
      if [ -n "$REMOVED_LINES" ] && printf '%s\n' "$REMOVED_LINES" \
          | grep -qE "(^|[^A-Za-z0-9_])$(escape_ere "$token")([^A-Za-z0-9_]|\$)"; then
        return 0
      fi
      ;;
  esac
  return 1
}

# Escape ERE metacharacters in a token so it matches literally inside grep -E.
escape_ere() {
  # The sed program is a literal BRE replacement; the single quotes are
  # deliberate (no shell expansion intended). shellcheck SC2016 does not apply.
  # shellcheck disable=SC2016
  printf '%s' "$1" | sed -E 's/[.[\$()*+?{|^]/\\&/g'
}

# ---------------------------------------------------------------------------
# Main scan: for each mapped token, if it was changed, surface its consumers.
# ---------------------------------------------------------------------------
scan() {
  local hits=0
  local type token consumers
  while IFS=$'\t' read -r type token consumers; do
    [ -n "$token" ] || continue
    if token_hit "$type" "$token"; then
      hits=$((hits + 1))
      # Normalise <br> and ; into a readable comma list for the warning.
      local clist
      clist="$(printf '%s' "$consumers" | sed -E 's/<br>/, /g; s/[[:space:]]+/ /g')"
      echo "[contract-check] '$token' ($type) is a mapped contract changed in this diff." >&2
      echo "[contract-check]   Consumers that may break: $clist" >&2
      echo "[contract-check]   Sweep them in this commit, or update MAINTAINING.md if the contract is genuinely retired." >&2
    fi
  done < <(parse_map)

  if [ "$hits" -gt 0 ]; then
    echo "[contract-check] $hits mapped contract(s) touched (WARNING — not blocking). See above." >&2
  fi
  return 0
}

main() {
  check_deps
  parse_args "$@"
  resolve_paths

  # HARD-FAIL gate: stale-map self-consistency, only when MAINTAINING.md is
  # staged (staged mode) or always in --paths advisory mode if the map exists.
  local fail=0
  if [ "$MODE" = "staged" ]; then
    collect_changes
    if map_is_staged; then
      if ! check_map_self_consistency; then
        fail=1
      fi
    fi
    scan
  else
    # paths (advisory) mode — preview consumers, always validate the map too.
    collect_changes
    if ! check_map_self_consistency; then
      fail=1
    fi
    scan
  fi

  if [ "$fail" = "1" ]; then
    echo "[contract-check] MAINTAINING.md is stale — fix the consumer citation(s) above before committing." >&2
    exit 1
  fi
  exit 0
}

main "$@"
