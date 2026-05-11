#!/bin/bash
set -euo pipefail

# Description: Verify byte-equality between pairs of files (e.g. repo source
#              vs deployed mirror copy). Produces a self-evidencing report:
#              for every pair, the realpath of both sides, the exact diff
#              command run, its exit code, and its stdout are printed so the
#              verdict can be audited rather than trusted.
#
#              Created in response to BR-062 — sentinel produced a false-PASS
#              verdict on a 4-pair mirror check during TD-080 round-1 because
#              the verification was narrative ("they match") rather than
#              command-evidenced. This primitive forecloses that failure mode:
#              its output cannot be misread as PASS unless every pair shows
#              `verdict: MATCH` AND the SUMMARY line shows zero non-MATCH.
#
# Usage:
#   verify_mirror.sh A1 B1 [A2 B2 ...]
#
#   Pairs are positional: arg 1 vs arg 2, arg 3 vs arg 4, etc.
#   The arg count MUST be even and >= 2; otherwise exit code 2 (usage error).
#
# Exit codes:
#   0 - All pairs MATCH (byte-equal, distinct inodes, both readable)
#   1 - Any pair MISMATCH | MISSING | SAME_INODE | TYPE_ERROR | ERROR
#   2 - Usage error (no args, odd arg count, missing dependency)
#
# Pair verdicts:
#   MATCH       diff -q returned RC=0 with empty output and the two paths
#               resolved to distinct inodes.
#   MISMATCH    diff -q returned RC=1 OR produced non-empty output. A sample
#               of the unified diff (first 40 lines) is included for context.
#   MISSING     One or both paths could not be realpath-resolved (file
#               does not exist, permission denied, broken symlink).
#   SAME_INODE  Both paths resolved to the same inode. A "byte-equality"
#               claim against a path resolving to itself is a tautology, not
#               a verification — flagged as a critical FAIL per BR-062.
#   TYPE_ERROR  At least one path resolved to a non-regular file
#               (directory, FIFO, socket, device). Comparing such inputs
#               with diff is undefined or recursive; rejected upfront (TD-085).
#   ERROR       diff itself returned RC>=2 (e.g. binary file with no text
#               representation, system-level error).
#
# Dependencies:
#   bash 4+, coreutils (realpath, diff, head, wc, stat). All standard on macOS,
#   Linux, and WSL — the platforms the Igris coding guidelines target.
#
# Self-evidencing guarantee (BR-062 contract):
#   For every pair, the report MUST contain the literal substrings
#   `command:`, `exit code:`, and `verdict:`. No verdict is emitted without
#   its supporting evidence on the same line or immediately above it.
#
# References:
#   BR-062 — sentinel false-PASS on mirror integrity verification
#   coding_guidelines.md §13 — file header convention
#   coding_guidelines.md §3 — bash standards (set -euo pipefail, quoting)

# ============================================================
# Dependency validation
# ============================================================
check_deps() {
  local missing=()
  for cmd in realpath diff head wc stat; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo "Error: required command(s) not found: ${missing[*]}" >&2
    echo "" >&2
    echo "Install GNU coreutils (provides realpath, diff, head, wc, stat):" >&2
    echo "  macOS:  brew install coreutils" >&2
    echo "  Ubuntu: sudo apt install coreutils" >&2
    echo "  WSL:    sudo apt install coreutils" >&2
    exit 2
  fi
}

# ============================================================
# Usage
# ============================================================
print_usage() {
  cat >&2 <<'USAGE'
Usage: verify_mirror.sh A1 B1 [A2 B2 ...]

Verify byte-equality between pairs of files. Pairs are positional:
arg 1 is compared to arg 2, arg 3 to arg 4, etc.

Arg count must be even and >= 2.

Exit codes:
  0 - All pairs MATCH
  1 - Any pair MISMATCH | MISSING | SAME_INODE | TYPE_ERROR | ERROR
  2 - Usage error
USAGE
}

# ============================================================
# File-type description (cross-platform stat)
# ----------------------------------------------------------------
# macOS BSD stat uses `-f '%HT'` (e.g. "Regular File", "Directory").
# GNU stat uses `-c '%F'` (e.g. "regular file", "directory"). Try BSD
# first (cheaper failure path on macOS), fall back to GNU, then "unknown".
# Used only for the TYPE_ERROR diagnostic message — NOT for verdict logic.
# Casing differs across platforms (cosmetic — verdict is what assertions match).
# ============================================================
describe_file_type() {
  local p="$1"
  stat -f '%HT' "$p" 2>/dev/null \
    || stat -c '%F' "$p" 2>/dev/null \
    || echo "unknown"
}

# ============================================================
# Per-pair check
# ----------------------------------------------------------------
# Prints a self-evidencing block to stdout. Sets the global counters
# c_match / c_mismatch / c_missing / c_same_inode / c_type_error / c_error.
# Returns 0 on MATCH, 1 otherwise so the caller can aggregate an overall RC.
# ============================================================
check_pair() {
  local idx="$1"
  local a="$2"
  local b="$3"

  echo "PAIR $idx: $a <-> $b"

  # Resolve realpaths. `|| true` so set -e does not abort on missing files.
  local realpath_a realpath_b
  realpath_a=$(realpath "$a" 2>/dev/null || true)
  realpath_b=$(realpath "$b" 2>/dev/null || true)

  echo "  realpath A: ${realpath_a:-<unresolved>}"
  echo "  realpath B: ${realpath_b:-<unresolved>}"

  # MISSING: one or both paths could not be resolved.
  if [ -z "$realpath_a" ] || [ -z "$realpath_b" ]; then
    local which_missing=""
    [ -z "$realpath_a" ] && which_missing="A"
    [ -z "$realpath_b" ] && which_missing="${which_missing:+$which_missing+}B"
    echo "  command:    (skipped — realpath could not resolve side $which_missing)"
    echo "  exit code:  n/a"
    echo "  stdout:     "
    echo "  verdict:    MISSING"
    echo ""
    c_missing=$((c_missing + 1))
    return 1
  fi

  # SAME_INODE: both paths resolve to the same inode. A byte-equality claim
  # against a path resolving to itself is meaningless (BR-062 hypothesis 3).
  if [ "$realpath_a" = "$realpath_b" ]; then
    echo "  command:    (skipped — both paths resolve to the same inode)"
    echo "  exit code:  n/a"
    echo "  stdout:     $realpath_a == $realpath_b"
    echo "  verdict:    SAME_INODE"
    echo ""
    c_same_inode=$((c_same_inode + 1))
    return 1
  fi

  # TYPE_ERROR: both paths resolved, distinct inodes, but at least one is
  # not a regular file (directory, FIFO, socket, device). diff against a
  # directory either silently recurses (GNU) or produces non-comparable
  # output (BSD); against a FIFO it blocks. Reject upfront with a verdict
  # that names the actual types so the failure is self-explanatory (TD-085).
  if [ ! -f "$a" ] || [ ! -f "$b" ]; then
    local type_a type_b
    type_a=$(describe_file_type "$a")
    type_b=$(describe_file_type "$b")
    echo "  command:    (skipped — expected regular files)"
    echo "  exit code:  n/a"
    echo "  stdout:     A type=$type_a, B type=$type_b"
    echo "  verdict:    TYPE_ERROR"
    echo ""
    c_type_error=$((c_type_error + 1))
    return 1
  fi

  # Run diff -q. Capture stdout+stderr together AND the exit code in a single
  # invocation — `set +e` lets `$?` survive without aborting under `set -e`.
  # Single invocation eliminates a class of TOCTOU bugs where the file changed
  # between the two diffs (TD-084).
  echo "  command:    diff -q \"$a\" \"$b\""
  local diff_out diff_rc
  set +e
  diff_out=$(diff -q "$a" "$b" 2>&1)
  diff_rc=$?
  set -e

  echo "  exit code:  $diff_rc"
  if [ -z "$diff_out" ]; then
    echo "  stdout:     <empty>"
  else
    echo "  stdout:     $diff_out"
  fi

  # Classify based on RC first, then output. RC ordering matters: diff's
  # convention is RC=0 (identical), RC=1 (different), RC>=2 (error). We
  # check ERROR before MISMATCH because diff emits a non-empty stderr
  # message on permission-denied / binary-no-text errors, which would
  # otherwise be misclassified as MISMATCH if we only looked at output.
  if [ "$diff_rc" -ge 2 ]; then
    # RC >= 2 — diff itself failed (binary file, permission denied,
    # system-level error). Stderr is captured in diff_out and was already
    # printed above as `stdout:` evidence.
    echo "  verdict:    ERROR"
    echo ""
    c_error=$((c_error + 1))
    return 1
  elif [ "$diff_rc" -eq 0 ] && [ -z "$diff_out" ]; then
    echo "  verdict:    MATCH"
    echo ""
    c_match=$((c_match + 1))
    return 0
  else
    # RC=1 (files differ) OR RC=0 with non-empty output (anomalous but
    # treated as MISMATCH for safety). Capture a sample of the unified
    # diff for context.
    local sample
    sample=$(diff "$a" "$b" 2>&1 | head -40 || true)
    echo "  verdict:    MISMATCH"
    if [ -n "$sample" ]; then
      echo "  sample:     |"
      # Indent each sample line for readability and so the block is
      # unambiguously bound to the verdict above it. Bash parameter
      # expansion replaces every newline with newline+14-space indent;
      # the leading indent is added in the printf template for the first
      # line.
      local indented="${sample//$'\n'/$'\n              '}"
      printf '              %s\n' "$indented"
    fi
    echo ""
    c_mismatch=$((c_mismatch + 1))
    return 1
  fi
}

# ============================================================
# Main
# ============================================================
main() {
  check_deps

  if [ "$#" -eq 0 ]; then
    echo "Error: no arguments provided" >&2
    echo "" >&2
    print_usage
    exit 2
  fi

  if [ $(( $# % 2 )) -ne 0 ]; then
    echo "Error: arg count must be even (received $#)" >&2
    echo "       Pairs are positional: A1 B1 A2 B2 ..." >&2
    echo "" >&2
    print_usage
    exit 2
  fi

  # Counters (global so check_pair can mutate)
  c_match=0
  c_mismatch=0
  c_missing=0
  c_same_inode=0
  c_type_error=0
  c_error=0

  local pair_idx=1
  local overall_rc=0

  # Iterate two args at a time.
  while [ "$#" -gt 0 ]; do
    local a="$1"
    local b="$2"
    shift 2
    if ! check_pair "$pair_idx" "$a" "$b"; then
      overall_rc=1
    fi
    pair_idx=$((pair_idx + 1))
  done

  local total=$((c_match + c_mismatch + c_missing + c_same_inode + c_type_error + c_error))
  echo "SUMMARY: $total pairs — $c_match MATCH, $c_mismatch MISMATCH, $c_missing MISSING, $c_same_inode SAME_INODE, $c_type_error TYPE_ERROR, $c_error ERROR"

  exit "$overall_rc"
}

main "$@"
