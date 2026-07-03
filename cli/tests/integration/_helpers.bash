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

# stage_home — an isolated HOME with a CLEAN doctor baseline, so ONLY the drift a
# test deliberately injects fires (never the ambient real ~/.claude state).
# Writes:
#   - $HOME/.claude.json          — valid igris-brain MCP entry (600) so
#                                    mcp-unregistered + secret-perms stay silent.
#   - $HOME/.claude/settings.json — the canonical global Igris hooks (a
#                                    hooks-missing/stale test OVERWRITES this).
#   - $IGRIS_BRAIN_DIR/config.json — opt-out `cli_targets:{}` (600) so
#                                    bridge-missing never fires from a real CLI
#                                    on the runner's PATH.
# Echoes the HOME path. Run the CLI under it with `HOME="$h" run $CLI_BIN ...`.
#
# TD-299: the FR-212d global-hooks detector reads $HOME/.claude/settings.json via
# homedir(); without this isolation `doctor` reads the runner's REAL ~/.claude
# (which carries canonical hooks) and misses the injected drift → exit 0. Call
# AFTER stage_brain (needs $IGRIS_BRAIN_DIR + its canonical-settings.json).
stage_home() {
  local home="$BATS_TEST_TMPDIR/home"
  mkdir -p "$home/.claude"
  local mcpfile="$IGRIS_BRAIN_DIR/fake-bundled-mcp.js"
  printf '// fake bundled mcp\n' > "$mcpfile"
  cat > "$home/.claude.json" <<EOF
{ "mcpServers": { "igris-brain": { "type": "stdio", "command": "node", "args": ["$mcpfile"], "env": {} } } }
EOF
  chmod 600 "$home/.claude.json"
  cp "$IGRIS_BRAIN_DIR/core/hooks/canonical-settings.json" "$home/.claude/settings.json"
  printf '{ "version": "7.0.0", "cli_targets": {} }\n' > "$IGRIS_BRAIN_DIR/config.json"
  chmod 600 "$IGRIS_BRAIN_DIR/config.json"
  echo "$home"
}
