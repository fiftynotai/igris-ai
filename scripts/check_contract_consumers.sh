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
#   check_contract_consumers.sh --map <file>    # override map location (tests)
#
# Default verdict: WARN (exit 0) — a renamed/deleted contract is usually
#   intentional; the checker informs, it does not veto. The ONE hard-fail is a
#   STALE MAP: a staged MAINTAINING.md whose consumer citation names a file that
#   does not exist (exit 1). Line-number drift is warned, not failed.
#
# Dependencies: git, grep, sed, awk (all POSIX-standard; no sqlite3/jq).
# Exit codes:
#   0 - clean, or consumers surfaced as a WARNING (default non-blocking case)
#   1 - stale map (a consumer citation's file does not exist)
#   2 - usage error

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
        sed -n '3,30p' "$0"
        exit 0
        ;;
      *)
        echo "Error: unknown argument '$1'" >&2
        echo "Usage: $0 [--paths <p>...] [--map <file>]" >&2
        exit 2
        ;;
    esac
  done
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
# Self-consistency (HARD-FAIL): when MAINTAINING.md itself is staged, every
# `path:line` citation in a Consumers cell must resolve to an existing file.
# A citation to a nonexistent file = stale map = exit 1. Line numbers are NOT
# validated (they drift); only the path's existence is load-bearing.
# ---------------------------------------------------------------------------
check_map_self_consistency() {
  local bad=0
  local citation path
  # Pull every `path:line` token out of the Consumers column. A consumer cell
  # looks like: `path/to/file.ext:NN` (file) text<br>`other:MM` ...
  # We accept tokens that contain a "/" and a ":" and end in :<digits>, OR a
  # bare path:line. Restrict to repo-relative paths (no leading ~ or /).
  while IFS= read -r citation; do
    # Strip a trailing :<line> if present.
    path="${citation%:*}"
    # Skip home-rooted or absolute citations (e.g. ~/.igris/...): the map
    # documents those as runtime/external readers, not repo files to validate.
    case "$path" in
      "~"*|/*|"") continue ;;
    esac
    if [ ! -e "$REPO_ROOT/$path" ]; then
      echo "[contract-check] STALE MAP: consumer citation '$citation' names a file that does not exist: $REPO_ROOT/$path" >&2
      bad=1
    fi
  done < <(
    # Pull `path:line` tokens out of the backtick-quoted citations. The single
    # quotes are deliberate — we match LITERAL backtick characters, not a shell
    # expansion. shellcheck SC2016 does not apply.
    # shellcheck disable=SC2016
    parse_map | cut -f3 | tr ';' '\n' \
      | grep -oE '`[^`]+`' | tr -d '`' \
      | grep -E '^[A-Za-z0-9_./~-]+:[0-9]+$' || true
  )
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
