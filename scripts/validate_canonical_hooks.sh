#!/bin/bash
set -e

# Description: Validates that the hooks block emitted by
#   scripts/hook-adapters/install_claude_hooks.sh stays byte-equal (after
#   key-sorted JSON canonicalization) to core/hooks/canonical-settings.json.
#   These two surfaces are the §13-paired "canonical Igris hooks" sources;
#   drift between them ships TD-100-style silent failures (correct shell
#   emission with stale CLI fallback, or vice versa).
#
#   Strategy: sandboxed dry-run. We invoke install_claude_hooks.sh against
#   an empty .claude/settings.json in a mktemp -d sandbox, then compare its
#   emitted .hooks block (jq -S) against the canonical .hooks block (jq -S).
#   This exercises the actual installer code path — drift in any part of
#   install_claude_hooks.sh that affects emitted hooks (not just lines
#   178-211) is caught.
#
#   The sandbox sets IGRIS_SHARED_DIR to the canonical literal so the
#   emitted commands match canonical-settings.json byte-for-byte without
#   patching the installer.
#
# Usage: scripts/validate_canonical_hooks.sh
# Env overrides (test injection):
#   CANONICAL_FILE     override canonical path (default: core/hooks/canonical-settings.json)
#   INSTALLER_SCRIPT   override installer path (default: scripts/hook-adapters/install_claude_hooks.sh)
# Exit codes:
#   0 - Emitted hooks block matches canonical-settings.json (jq -S diff)
#   1 - Drift detected (unified diff printed to stderr)
#   2 - Source files missing OR installer crashed during sandbox dry-run
#
# Wired into pre-commit when either file is staged. See
# scripts/git-hooks/pre-commit.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANONICAL_FILE="${CANONICAL_FILE:-$REPO_ROOT/core/hooks/canonical-settings.json}"
INSTALLER_SCRIPT="${INSTALLER_SCRIPT:-$REPO_ROOT/scripts/hook-adapters/install_claude_hooks.sh}"

if [ ! -f "$CANONICAL_FILE" ]; then
  echo "Error: canonical file not found: $CANONICAL_FILE" >&2
  exit 2
fi
if [ ! -f "$INSTALLER_SCRIPT" ]; then
  echo "Error: installer script not found: $INSTALLER_SCRIPT" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required for canonical-hooks validation" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  # The installer itself depends on python3 for JSON merging — skip if
  # absent rather than report drift on a system that can't run it.
  echo "Error: python3 is required (installer dependency)" >&2
  exit 2
fi

# Sandbox setup. mktemp -d gives us a clean .claude/ tree the installer
# can write into without touching the real repo or any project on disk.
SANDBOX="$(mktemp -d -t igris-canonical-hooks-XXXXXX)"
# shellcheck disable=SC2064  # We want $SANDBOX expanded now, not at trap time.
trap "rm -rf '$SANDBOX'" EXIT

mkdir -p "$SANDBOX/.claude"
echo '{}' > "$SANDBOX/.claude/settings.json"

# Match the canonical literal so emitted commands are byte-equal to the
# canonical file's commands. The literal `$HOME/...` is intentional —
# Claude Code expands $HOME at runtime; the canonical file stores the
# literal too (see core/hooks/canonical-settings.json:9).
#
# IGRIS_HOOK_CMD_PREFIX is normally set by _common.sh (sourced by the
# installer at line 26). Exporting it here is belt-and-suspenders against
# any sourcing edge case.
export IGRIS_SHARED_DIR='$HOME/.igris/core/hooks/shared'
export IGRIS_HOOK_CMD_PREFIX='$HOME/.igris/core/hooks/'

# Run the installer against the sandbox. set -e is intentionally bypassed
# here so we can capture the exit code and report a clear diagnostic.
INSTALLER_LOG="$SANDBOX/installer.log"
if ! bash "$INSTALLER_SCRIPT" --project-dir="$SANDBOX" > "$INSTALLER_LOG" 2>&1; then
  installer_status=$?
  echo "Error: installer script failed (exit $installer_status):" >&2
  echo "  $INSTALLER_SCRIPT --project-dir=$SANDBOX" >&2
  if [ -s "$INSTALLER_LOG" ]; then
    echo "--- installer output ---" >&2
    cat "$INSTALLER_LOG" >&2
    echo "--- end installer output ---" >&2
  fi
  exit 2
fi

EMITTED_FILE="$SANDBOX/.claude/settings.json"
if [ ! -f "$EMITTED_FILE" ]; then
  echo "Error: installer ran but produced no $EMITTED_FILE" >&2
  exit 2
fi

# Canonicalize both .hooks blocks via jq -S (sort keys recursively) so the
# diff ignores whitespace and key ordering. We compare ONLY the .hooks
# subtree — the canonical file has a top-level _doc field for human
# readability that the emitted file doesn't carry.
EMITTED_JSON="$(jq -S '.hooks' "$EMITTED_FILE")"
CANONICAL_JSON="$(jq -S '.hooks' "$CANONICAL_FILE")"

if [ "$EMITTED_JSON" = "$CANONICAL_JSON" ]; then
  echo "OK: install_claude_hooks.sh hooks block matches canonical-settings.json"
  exit 0
fi

echo "Error: hooks block emitted by install_claude_hooks.sh diverges from canonical-settings.json" >&2
echo "" >&2
echo "--- canonical-settings.json (.hooks, jq -S) ---" >&2
echo "$CANONICAL_JSON" >&2
echo "--- emitted by installer (.hooks, jq -S) ---" >&2
echo "$EMITTED_JSON" >&2
echo "--- unified diff ---" >&2
diff -u \
  <(echo "$CANONICAL_JSON") \
  <(echo "$EMITTED_JSON") >&2 || true
echo "" >&2
echo "Fix: edit core/hooks/canonical-settings.json AND scripts/hook-adapters/install_claude_hooks.sh:178-211" >&2
echo "     in lockstep (§13 paired surfaces). Re-run this script to confirm." >&2
exit 1
