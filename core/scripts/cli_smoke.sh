#!/bin/bash
set -euo pipefail

# Description: Smoke test for the Igris CLI. Runs `igris --version`,
#              `igris install --help`, `igris update --help`, `igris doctor`
#              (read-only against the current registry); asserts exit code
#              per command and prints a PASS/FAIL summary.
#
#              Used by sentinel during /hunt to confirm the CLI is functional
#              after Phase 1 lands. Not invoked by /boot or any hot path —
#              this is a manual diagnostic.
#
# Usage: cli_smoke.sh [--bin <path-to-igris>]
#
# Defaults to `igris` on PATH when --bin is omitted; falls back to
# $REPO_ROOT/cli/dist/index.js when igris is not on PATH.
#
# Exit codes:
#   0 - All commands returned the expected exit codes
#   1 - Any command failed unexpectedly
#   2 - Usage error or igris binary not found

# ============================================================
# Resolve the igris binary
# ============================================================
IGRIS_BIN=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin)
      shift
      IGRIS_BIN="${1:-}"
      ;;
    --bin=*)
      IGRIS_BIN="${1#--bin=}"
      ;;
    -h|--help)
      echo "Usage: $0 [--bin <path-to-igris>]"
      exit 0
      ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$IGRIS_BIN" ]; then
  if command -v igris &>/dev/null; then
    IGRIS_BIN="igris"
  else
    # Fallback: try the source repo's dist/index.js (developer pre-link).
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    CANDIDATE="$REPO_ROOT/cli/dist/index.js"
    if [ -x "$CANDIDATE" ] || [ -f "$CANDIDATE" ]; then
      IGRIS_BIN="node $CANDIDATE"
    else
      echo "Error: igris binary not found." >&2
      echo "  Pass --bin <path>, install via 'cd cli && npm link', or build via 'npm run build'." >&2
      exit 2
    fi
  fi
fi

echo "==================================================="
echo "Igris CLI Smoke Test"
echo "==================================================="
echo "Binary: $IGRIS_BIN"
echo ""

# ============================================================
# Run each smoke command
# ============================================================
PASS=0
FAIL=0

run_check() {
  local label="$1"
  local expected_exit="$2"
  shift 2
  echo "[CHECK] $label"
  set +e
  $IGRIS_BIN "$@" >/dev/null 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq "$expected_exit" ]; then
    echo "  PASS (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL (got exit $rc, expected $expected_exit)"
    FAIL=$((FAIL + 1))
  fi
}

run_check "igris --version"      0 --version
run_check "igris install --help" 0 install --help
run_check "igris update --help"  0 update --help
run_check "igris doctor --help"  0 doctor --help

# `igris doctor` against the live registry: exit code is 0 if clean, 1 if
# drift. Either is "the CLI is working"; we only fail on rc>=2 (usage error)
# or unexpected crash.
echo "[CHECK] igris doctor (live registry)"
set +e
$IGRIS_BIN doctor >/dev/null 2>&1
DOCTOR_RC=$?
set -e
if [ "$DOCTOR_RC" -eq 0 ] || [ "$DOCTOR_RC" -eq 1 ]; then
  echo "  PASS (exit $DOCTOR_RC; registry status: $([ "$DOCTOR_RC" -eq 0 ] && echo clean || echo "drift detected"))"
  PASS=$((PASS + 1))
else
  echo "  FAIL (got exit $DOCTOR_RC; expected 0 or 1)"
  FAIL=$((FAIL + 1))
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo "==================================================="
echo "SUMMARY: $PASS passed, $FAIL failed"
echo "==================================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
