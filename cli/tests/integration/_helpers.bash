#!/usr/bin/env bash
# Bats helper: setup/teardown of sandboxed brain dir + fixture project trees.
#
# Every test sets IGRIS_BRAIN_DIR=$BATS_TEST_TMPDIR/igris-brain so the CLI's
# DB / canonical hooks file / installed_features.json land in tmp space.
# We seed:
#   - $IGRIS_BRAIN_DIR/core/hooks/canonical-settings.json (stub)
#   - $IGRIS_BRAIN_DIR/memory/ (empty — registry.ts creates table on demand)
#
# Tests invoke the CLI via `node $CLI_DIST/index.js ...` to avoid any global
# install dependency.

set -euo pipefail

# CLI_DIST resolved at first include — falls back to the workspace dist dir
# if not preset.
if [ -z "${CLI_DIST:-}" ]; then
  CLI_DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../dist" && pwd)"
fi
export CLI_DIST

# CLI_BIN — the actual node command tests should run.
CLI_BIN="node $CLI_DIST/index.js"
export CLI_BIN

# Stub canonical hooks (matches the shape of core/hooks/canonical-settings.json)
read -r -d '' STUB_CANONICAL_HOOKS <<'JSON' || true
{
  "hooks": {
    "SessionStart": [{"hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/session_start.sh"}]}],
    "SessionEnd":   [{"hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/session_end.sh"}]}],
    "PreCompact":   [{"hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/pre_compact.sh"}]}],
    "PostCompact":  [{"hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/post_compact.sh"}]}],
    "PreToolUse":   [{"matcher":"Write|Edit","hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/pre_tool_use.sh"}]}],
    "PostToolUse":  [{"matcher":"Write|Edit","hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/post_tool_use.sh","timeout":20}]}]
  }
}
JSON
export STUB_CANONICAL_HOOKS

# stage_brain — populates $BATS_TEST_TMPDIR/igris-brain with the canonical hooks
# fixture and creates the memory/ dir. Sets IGRIS_BRAIN_DIR for the test.
stage_brain() {
  export IGRIS_BRAIN_DIR="$BATS_TEST_TMPDIR/igris-brain"
  mkdir -p "$IGRIS_BRAIN_DIR/core/hooks"
  mkdir -p "$IGRIS_BRAIN_DIR/memory"
  printf '%s\n' "$STUB_CANONICAL_HOOKS" > "$IGRIS_BRAIN_DIR/core/hooks/canonical-settings.json"
}

# stage_project <subdir-name> — creates a fresh project tree at
# $BATS_TEST_TMPDIR/<subdir> with .claude/ pre-created. Echoes the path.
stage_project() {
  local name="${1:-proj}"
  local dir="$BATS_TEST_TMPDIR/$name"
  mkdir -p "$dir/.claude"
  echo "$dir"
}
