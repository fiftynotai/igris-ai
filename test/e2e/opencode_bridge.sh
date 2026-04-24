#!/usr/bin/env bash
#
# test/e2e/opencode_bridge.sh — End-to-end smoke for the OpenCode plugin bridge.
#
# Skips with exit 77 when OpenCode isn't installed or credentials are missing.
# On pass, exits 0. On failure, exits 1.
#
# Scope:
#   Verifies that installing the bridge at `~/.config/opencode/plugins/` and
#   running `opencode run` produces session_start + session_end dispatches via
#   the IGRIS_BRIDGE_TRACE log.
#
# Not covered (documented in docs/multi-cli.md):
#   - tool.execute.before / tool.execute.after — requires the provider to issue
#     tool calls, which is provider-dependent. Bridge code verified by review
#     and `bun build` compile, not by live tool invocation.
#   - pre_compact / post_compact — short prompts do not trigger compaction.

set -u

BRIDGE_SRC="$(cd "$(dirname "$0")/../.." && pwd)/core/hooks/bridges/opencode/igris-bridge.ts"
PLUGIN_DIR="$HOME/.config/opencode/plugins"
PLUGIN_PATH="$PLUGIN_DIR/igris-bridge.ts"
TMP_DIR=$(mktemp -d -t opencode-bridge-e2e-XXXXXX)
TRACE="$TMP_DIR/trace.log"

# shellcheck disable=SC2329  # invoked indirectly via trap
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

skip() {
  echo "SKIP: $1" >&2
  exit 77
}

fail() {
  echo "FAIL: $1" >&2
  [ -f "$TRACE" ] && { echo "--- trace ---" >&2; cat "$TRACE" >&2; }
  exit 1
}

command -v opencode >/dev/null 2>&1 || skip "opencode not installed"
command -v bun >/dev/null 2>&1 || skip "bun not installed (required by opencode plugins)"
[ -f "$BRIDGE_SRC" ] || fail "bridge source missing at $BRIDGE_SRC"

# Bridge must be installed as a plugin — prefer a symlink to the repo source so
# local edits stay live. Any pre-existing plugin is left alone.
mkdir -p "$PLUGIN_DIR"
if [ ! -e "$PLUGIN_PATH" ]; then
  ln -s "$BRIDGE_SRC" "$PLUGIN_PATH"
  INSTALLED_BY_TEST=1
else
  INSTALLED_BY_TEST=0
fi

# Provider: Z.AI coding plan is the only one the Igris team has wired into the
# fixture. Fall back to skip if no credential is set — hooks can't fire without
# a session, and a session needs a reachable provider.
if [ -z "${ZAI_API_KEY:-}" ]; then
  [ "$INSTALLED_BY_TEST" -eq 1 ] && rm -f "$PLUGIN_PATH"
  skip "ZAI_API_KEY not set — cannot exercise bridge without a configured provider"
fi

# Tiny throwaway project so the bridge can resolve a project_dir.
cd "$TMP_DIR" || fail "could not cd to $TMP_DIR"
git init -q 2>/dev/null || true
echo "# smoke" > README.md

IGRIS_BRIDGE_TRACE="$TRACE" \
  timeout 60 opencode run \
    --model zai/glm-4.5-air \
    "respond with only: ok" \
  >/dev/null 2>&1 || true

[ "$INSTALLED_BY_TEST" -eq 1 ] && rm -f "$PLUGIN_PATH"

[ -f "$TRACE" ] || fail "trace file never created — bridge did not load"

grep -q "dispatch event=session_start" "$TRACE" \
  || fail "session_start never dispatched"
grep -q "dispatch event=session_end" "$TRACE" \
  || fail "session_end never dispatched"

# Dedupe check — each should fire exactly once for a single run.
start_count=$(grep -c "dispatch event=session_start" "$TRACE" || true)
end_count=$(grep -c "dispatch event=session_end" "$TRACE" || true)
[ "$start_count" = "1" ] || fail "expected 1 session_start dispatch, got $start_count"
[ "$end_count" = "1" ] || fail "expected 1 session_end dispatch, got $end_count"

echo "PASS: session_start + session_end dispatched exactly once"
exit 0
