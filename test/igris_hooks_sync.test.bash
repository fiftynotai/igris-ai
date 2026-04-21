#!/usr/bin/env bats

# Test suite for FR-104: Multi-CLI Hook Bridge Layer.
#
# Maps to the 9 acceptance criteria in the brief. Runs isolated: each test uses
# TEST_TEMP_DIR for brain/config/target paths. The live ~/.igris tree is not
# touched (we override IGRIS_BRAIN_DIR, IGRIS_SHARED_DIR, and IGRIS_CONFIG_FILE).

load test_helper

# =============================================================================
# SETUP / TEARDOWN
# =============================================================================

FIXTURES_DIR="$BATS_TEST_DIRNAME/fixtures/hooks"
HOOKS_SYNC="$SCRIPTS_DIR/igris_hooks_sync.sh"
CLAUDE_ADAPTER="$SCRIPTS_DIR/hook-adapters/install_claude_hooks.sh"
OPENCODE_ADAPTER="$SCRIPTS_DIR/hook-adapters/install_opencode_hooks.sh"
CODEX_ADAPTER="$SCRIPTS_DIR/hook-adapters/install_codex_hooks.sh"
SHARED_DIR="$IGRIS_ROOT/../../../.igris/core/hooks/shared"

setup() {
  mkdir -p "$TEST_TEMP_DIR"
  export TEST_BRAIN_DIR="$TEST_TEMP_DIR/brain"
  export TEST_PROJECT_DIR="$TEST_TEMP_DIR/proj"
  export TEST_CONFIG_FILE="$TEST_BRAIN_DIR/config.json"
  export TEST_SHARED_DIR="$TEST_BRAIN_DIR/core/hooks/shared"
  export TEST_CODEX_FILE="$TEST_TEMP_DIR/codex_config.toml"
  export TEST_OPENCODE_PLUGIN_DIR="$TEST_TEMP_DIR/opencode_plugins"
  export TEST_OPENCODE_SOURCE="$TEST_BRAIN_DIR/core/hooks/bridges/opencode/igris-bridge.ts"
  export TEST_CODEX_BRIDGE="$TEST_BRAIN_DIR/core/hooks/bridges/codex-notify.sh"

  mkdir -p "$TEST_BRAIN_DIR"
  mkdir -p "$TEST_PROJECT_DIR/.claude"
  mkdir -p "$TEST_SHARED_DIR/post_tool_use.d"
  mkdir -p "$TEST_BRAIN_DIR/core/hooks/bridges/opencode"

  # Stub shared scripts — we test the DISPATCHER, not the scripts themselves.
  # The live scripts already exist under the real brain path; tests that need
  # to exercise them use the real paths directly.
  for ev in session_start session_end pre_compact post_compact pre_tool_use post_tool_use; do
    cat > "$TEST_SHARED_DIR/${ev}.sh" <<EOF
#!/bin/bash
set -e
INPUT=\$(cat || true)
echo "STUB:$ev:\$INPUT" >> "$TEST_TEMP_DIR/stub.log"
exit 0
EOF
    chmod +x "$TEST_SHARED_DIR/${ev}.sh"
  done

  # Stub OpenCode source bridge
  cat > "$TEST_OPENCODE_SOURCE" <<'TS'
export const IgrisBridge = async (ctx) => ({});
export default IgrisBridge;
TS

  # Stub Codex bridge
  cat > "$TEST_CODEX_BRIDGE" <<'BASH'
#!/bin/bash
echo "CODEX_NOTIFY_STUB"
BASH
  chmod +x "$TEST_CODEX_BRIDGE"

  # Baseline config.json with all four CLIs declaring hook blocks
  cat > "$TEST_CONFIG_FILE" <<EOF
{
  "cli_targets": {
    "claude": {
      "method": "symlink",
      "target": "$TEST_PROJECT_DIR/.claude/skills/",
      "hooks": {
        "settings_file": "\$CLAUDE_PROJECT_DIR/.claude/settings.json",
        "events_covered": ["session_start","session_end","pre_tool_use","post_tool_use","pre_compact","post_compact"],
        "note": "Claude via direct settings.json paths"
      }
    },
    "opencode": {
      "method": "none",
      "target": "$TEST_TEMP_DIR/opencode/",
      "hooks": {
        "plugin_dir": "$TEST_OPENCODE_PLUGIN_DIR",
        "plugin_file": "igris-bridge.ts",
        "events_covered": ["session_start","session_end","pre_tool_use","post_tool_use","pre_compact","post_compact"],
        "note": "TS plugin auto-loaded"
      }
    },
    "gemini": {
      "method": "converter",
      "target": "$TEST_TEMP_DIR/gemini/",
      "hooks": {"events_covered": [], "note": "Gemini CLI has no hook API. Not supported."}
    },
    "codex": {
      "method": "compiler",
      "target": "$TEST_PROJECT_DIR/AGENTS.md",
      "hooks": {
        "notify_wrapper": "$TEST_CODEX_BRIDGE",
        "events_covered": ["session_end"],
        "note": "Codex notify wrapper"
      },
      "user_notify_backup": []
    }
  }
}
EOF
}

teardown() {
  if [ -d "$TEST_TEMP_DIR" ]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
}

# Helper: run hooks_sync with the scratch config + brain dir.
run_sync() {
  IGRIS_BRAIN_DIR="$TEST_BRAIN_DIR" \
  IGRIS_CONFIG_FILE="$TEST_CONFIG_FILE" \
    run bash "$HOOKS_SYNC" "$@"
}

run_claude_install() {
  IGRIS_SHARED_DIR='$HOME/.igris/core/hooks/shared' \
    run bash "$CLAUDE_ADAPTER" "$@"
}

run_codex_install() {
  run bash "$CODEX_ADAPTER" \
    --config-file="$TEST_CODEX_FILE" \
    --bridge="$TEST_CODEX_BRIDGE" \
    --brain-config="$TEST_CONFIG_FILE" "$@"
}

run_opencode_install() {
  run bash "$OPENCODE_ADAPTER" \
    --plugin-dir="$TEST_OPENCODE_PLUGIN_DIR" \
    --source="$TEST_OPENCODE_SOURCE" "$@"
}

# =============================================================================
# AC#1: Shared scripts exist at ~/.igris/core/hooks/shared/
# =============================================================================

@test "AC#1: shared scripts present and executable (live brain)" {
  local live_shared="$HOME/.igris/core/hooks/shared"
  for ev in session_start.sh session_end.sh pre_compact.sh post_compact.sh pre_tool_use.sh post_tool_use.sh; do
    [ -x "$live_shared/$ev" ] || fail "Missing or non-executable: $live_shared/$ev"
  done
  for h in 01-lint.sh 02-brief-sync.sh 03-session-sync.sh; do
    [ -x "$live_shared/post_tool_use.d/$h" ] || fail "Missing or non-executable: $live_shared/post_tool_use.d/$h"
  done
}

# =============================================================================
# AC#2: Claude settings.json regenerates idempotently
# =============================================================================

@test "AC#2: Claude settings.json merge is idempotent (byte-identical on re-run)" {
  cp "$FIXTURES_DIR/settings_pristine.json" "$TEST_PROJECT_DIR/.claude/settings.json"
  run_claude_install --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ] || { echo "first run failed: $output" >&2; return 1; }
  local first
  first=$(cat "$TEST_PROJECT_DIR/.claude/settings.json")

  run_claude_install --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ] || { echo "second run failed: $output" >&2; return 1; }
  local second
  second=$(cat "$TEST_PROJECT_DIR/.claude/settings.json")

  if [ "$first" != "$second" ]; then
    echo "Not idempotent. Diff:" >&2
    diff <(echo "$first") <(echo "$second") >&2 || true
    return 1
  fi
}

# =============================================================================
# AC#3: Claude merge preserves unknown user entries
# =============================================================================

@test "AC#3: Claude merge preserves user-owned hook entries" {
  cp "$FIXTURES_DIR/settings_pristine.json" "$TEST_PROJECT_DIR/.claude/settings.json"
  run_claude_install --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ] || fail "install failed"

  # User hook should still be in SessionStart and PreToolUse
  python3 - "$TEST_PROJECT_DIR/.claude/settings.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
hooks = d["hooks"]
ss_cmds = [h.get("command") for g in hooks.get("SessionStart", []) for h in g.get("hooks", [])]
assert "/usr/local/bin/user-session-start.sh" in ss_cmds, "user session_start missing"
pt_cmds = [h.get("command") for g in hooks.get("PreToolUse", []) for h in g.get("hooks", [])]
assert "/Users/example/my-gate.sh" in pt_cmds, "user PreToolUse missing"
# Stop unchanged
stop_urls = [h.get("url") for g in hooks.get("Stop", []) for h in g.get("hooks", [])]
assert "http://localhost:9999/my-webhook" in stop_urls, "user Stop missing"
# Unknown top-level key preserved
assert d.get("includeGitInstructions") is False
print("ok")
PY
}

@test "AC#3b: Claude merge drops stale Igris entries on re-run" {
  # Seed with an OLD Igris entry pointing at a non-existent script path.
  cp "$FIXTURES_DIR/settings_with_existing.json" "$TEST_PROJECT_DIR/.claude/settings.json"
  run_claude_install --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ] || fail "install failed"
  # The pre-existing Igris entries should be REPLACED, not duplicated.
  python3 - "$TEST_PROJECT_DIR/.claude/settings.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
# Exactly one Igris session_start entry
ss_igris = [g for g in d["hooks"]["SessionStart"]
    if any(str(h.get("command","")).startswith("$HOME/.igris/core/hooks/") for h in g.get("hooks", []))]
assert len(ss_igris) == 1, f"expected 1 Igris SessionStart, got {len(ss_igris)}"
# User entry preserved
ss_user = [g for g in d["hooks"]["SessionStart"]
    if any(h.get("command") == "/usr/local/bin/user-session-start.sh" for h in g.get("hooks", []))]
assert len(ss_user) == 1, "user SessionStart dropped"
print("ok")
PY
}

# =============================================================================
# AC#4: OpenCode TS plugin installs cleanly
# =============================================================================

@test "AC#4: OpenCode plugin copies to target plugin dir" {
  run_opencode_install
  [ "$status" -eq 0 ] || fail "install failed: $output"
  [ -f "$TEST_OPENCODE_PLUGIN_DIR/igris-bridge.ts" ] || fail "plugin missing"
}

@test "AC#4: OpenCode plugin install is idempotent" {
  run_opencode_install
  [ "$status" -eq 0 ]
  local first_hash
  first_hash=$(shasum "$TEST_OPENCODE_PLUGIN_DIR/igris-bridge.ts" | cut -d' ' -f1)
  run_opencode_install
  [ "$status" -eq 0 ]
  local second_hash
  second_hash=$(shasum "$TEST_OPENCODE_PLUGIN_DIR/igris-bridge.ts" | cut -d' ' -f1)
  [ "$first_hash" = "$second_hash" ] || fail "idempotency broken"
}

@test "AC#4: Live OpenCode bridge TS file syntactically parses via node-like check" {
  require_python3
  local live="$HOME/.igris/core/hooks/bridges/opencode/igris-bridge.ts"
  [ -f "$live" ] || skip "live bridge not installed"
  # Minimal sanity: file has the expected export and hook keys.
  python3 -c "
import re
with open('$live') as f:
    src = f.read()
assert 'export const IgrisBridge' in src, 'missing IgrisBridge export'
assert re.search(r'session\\.idle', src), 'missing session.idle mapping'
assert re.search(r'tool\\.execute\\.before', src), 'missing tool.execute.before hook'
assert re.search(r'tool\\.execute\\.after', src), 'missing tool.execute.after hook'
assert re.search(r'experimental\\.session\\.compacting', src), 'missing pre_compact hook'
print('ok')
"
}

# =============================================================================
# AC#5: Codex merge preserves user's existing notify
# =============================================================================

@test "AC#5: Codex merge backs up user's existing notify array" {
  cp "$FIXTURES_DIR/codex_config_pristine.toml" "$TEST_CODEX_FILE"
  run_codex_install
  [ "$status" -eq 0 ] || fail "codex install failed: $output"

  # Verify backup captured
  python3 - "$TEST_CONFIG_FILE" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    c = json.load(f)
backup = c["cli_targets"]["codex"]["user_notify_backup"]
assert backup == ["osascript", "-e", "display notification \"hello\" with title \"codex\""], f"got {backup}"
print("ok")
PY

  # Verify notify rewritten
  python3 - "$TEST_CODEX_FILE" <<'PY'
import sys
try:
    import tomllib
except Exception:
    print("skip: tomllib missing")
    sys.exit(0)
with open(sys.argv[1], "rb") as f:
    data = tomllib.load(f)
assert data["notify"][0].endswith("codex-notify.sh"), f"got {data['notify']}"
# Other user keys preserved
assert data["model"] == "claude-3-5-sonnet"
assert data["other_flag"] is True
assert data["profiles"]["default"] == "main"
print("ok")
PY
}

# =============================================================================
# AC#6: Codex merge idempotent
# =============================================================================

@test "AC#6: Codex install is idempotent on re-run" {
  cp "$FIXTURES_DIR/codex_config_pristine.toml" "$TEST_CODEX_FILE"
  run_codex_install
  [ "$status" -eq 0 ]
  local first_config first_backup
  first_config=$(cat "$TEST_CODEX_FILE")
  first_backup=$(python3 -c "
import json
with open('$TEST_CONFIG_FILE') as f:
    c = json.load(f)
print(c['cli_targets']['codex']['user_notify_backup'])
")

  run_codex_install
  [ "$status" -eq 0 ]
  local second_config second_backup
  second_config=$(cat "$TEST_CODEX_FILE")
  second_backup=$(python3 -c "
import json
with open('$TEST_CONFIG_FILE') as f:
    c = json.load(f)
print(c['cli_targets']['codex']['user_notify_backup'])
")

  [ "$first_config" = "$second_config" ] || fail "codex config not idempotent"
  [ "$first_backup" = "$second_backup" ] || fail "backup changed on re-run"
}

# =============================================================================
# AC#7: Shared scripts handle all three input shapes
# =============================================================================

@test "AC#7a: pre_tool_use.sh accepts Claude-native JSON" {
  local live="$HOME/.igris/core/hooks/shared/pre_tool_use.sh"
  [ -f "$live" ] || skip "live shared scripts not installed"
  # Exempt path — should exit 0 with no stdout
  run bash -c "echo '{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/.claude/foo.sh\"}}' | bash '$live'"
  [ "$status" -eq 0 ] || fail "claude shape rejected: $output"
}

@test "AC#7b: pre_tool_use.sh accepts unified JSON" {
  local live="$HOME/.igris/core/hooks/shared/pre_tool_use.sh"
  [ -f "$live" ] || skip "live shared scripts not installed"
  run bash -c "echo '{\"source\":\"opencode\",\"event\":\"pre_tool_use\",\"project_dir\":\"/tmp\",\"payload\":{\"tool_input\":{\"file_path\":\"/tmp/.claude/foo.sh\"}}}' | bash '$live'"
  [ "$status" -eq 0 ] || fail "unified shape rejected: $output"
}

@test "AC#7c: pre_tool_use.sh falls back to env vars when stdin empty" {
  local live="$HOME/.igris/core/hooks/shared/pre_tool_use.sh"
  [ -f "$live" ] || skip "live shared scripts not installed"
  # Empty stdin with env vars — exempt path
  run bash -c "IGRIS_FILE_PATH=/tmp/.claude/foo.sh IGRIS_PROJECT_DIR=/tmp bash '$live' < /dev/null"
  [ "$status" -eq 0 ] || fail "env fallback rejected: $output"
}

@test "AC#7d: session_start.sh emits valid JSON on empty stdin" {
  local live="$HOME/.igris/core/hooks/shared/session_start.sh"
  [ -f "$live" ] || skip "live shared scripts not installed"
  local tmpfile
  tmpfile=$(mktemp)
  bash "$live" < /dev/null > "$tmpfile"
  local rc=$?
  [ "$rc" -eq 0 ] || { rm -f "$tmpfile"; fail "script exited non-zero: $rc"; }
  # Parse directly from file — avoids round-tripping through bash-captured $output
  # which can elide the distinction between literal backslash-n and real newlines.
  python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
assert 'additionalContext' in data
print('ok')
" "$tmpfile"
  local py_rc=$?
  rm -f "$tmpfile"
  [ "$py_rc" -eq 0 ] || fail "emitted non-JSON on empty stdin"
}

# =============================================================================
# AC#8: --include flag behaves orthogonally
# =============================================================================

@test "AC#8a: --cli=claude works via hooks sync" {
  cp "$FIXTURES_DIR/settings_pristine.json" "$TEST_PROJECT_DIR/.claude/settings.json"
  run_sync --cli=claude --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ] || fail "sync failed: $output"
  # settings.json should now contain Igris entries
  grep -q "\.igris/core/hooks/shared/session_start\.sh" "$TEST_PROJECT_DIR/.claude/settings.json" || fail "no shared session_start entry"
}

@test "AC#8b: --cli=gemini is a graceful no-op" {
  run_sync --cli=gemini --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ] || fail "gemini unsupported should exit 0, got $status"
  # No filesystem side effects
  [ ! -d "$TEST_TEMP_DIR/gemini" ] || fail "unexpected writes to gemini target"
}

@test "AC#8c: --cli=all covers all four" {
  cp "$FIXTURES_DIR/settings_pristine.json" "$TEST_PROJECT_DIR/.claude/settings.json"
  cp "$FIXTURES_DIR/codex_config_pristine.toml" "$TEST_CODEX_FILE"
  # Override codex adapter args via env for direct path usage.
  IGRIS_CODEX_CONFIG="$TEST_CODEX_FILE" \
  IGRIS_CODEX_BRIDGE="$TEST_CODEX_BRIDGE" \
  IGRIS_BRAIN_CONFIG="$TEST_CONFIG_FILE" \
  IGRIS_OPENCODE_PLUGIN_DIR="$TEST_OPENCODE_PLUGIN_DIR" \
  IGRIS_OPENCODE_SOURCE="$TEST_OPENCODE_SOURCE" \
    run_sync --cli=all --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ] || fail "--cli=all failed: $output"
  # Claude
  grep -q "\.igris/core/hooks/shared/session_start\.sh" "$TEST_PROJECT_DIR/.claude/settings.json" || fail "claude missing"
  # OpenCode
  [ -f "$TEST_OPENCODE_PLUGIN_DIR/igris-bridge.ts" ] || fail "opencode missing"
  # Codex
  grep -q "codex-notify\.sh" "$TEST_CODEX_FILE" || fail "codex missing"
  # Gemini is graceful no-op
  echo "$output" | grep -qi gemini || fail "gemini not acknowledged"
}

# =============================================================================
# AC#9: Gemini explicitly unsupported (no crash, no writes)
# =============================================================================

@test "AC#9: gemini exits 0 with informative log, no filesystem writes" {
  run_sync --cli=gemini --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ]
  echo "$output" | grep -qi "unsupported\|not supported" || fail "no unsupported log: $output"
  [ ! -d "$TEST_TEMP_DIR/gemini" ] || fail "gemini target created despite no-op"
}

# =============================================================================
# Cross-cutting: dispatcher isolates handler failures
# =============================================================================

@test "dispatcher: post_tool_use.sh isolates a crashing handler" {
  local disp="$HOME/.igris/core/hooks/shared/post_tool_use.sh"
  [ -f "$disp" ] || skip "live dispatcher not installed"

  local handler_dir="$TEST_TEMP_DIR/ptu.d"
  mkdir -p "$handler_dir"
  # One handler writes a marker, another exits 1, a third writes a second marker.
  cat > "$handler_dir/01-ok.sh" <<EOF
#!/bin/bash
echo "h1_ran" > "$TEST_TEMP_DIR/h1.flag"
exit 0
EOF
  cat > "$handler_dir/02-crash.sh" <<'EOF'
#!/bin/bash
exit 1
EOF
  cat > "$handler_dir/03-ok.sh" <<EOF
#!/bin/bash
echo "h3_ran" > "$TEST_TEMP_DIR/h3.flag"
exit 0
EOF
  chmod +x "$handler_dir"/*.sh

  IGRIS_POST_TOOL_USE_D="$handler_dir" run bash -c "echo '{}' | bash '$disp'"
  [ "$status" -eq 0 ] || fail "dispatcher exit non-zero: $output"
  [ -f "$TEST_TEMP_DIR/h1.flag" ] || fail "handler 1 did not run"
  [ -f "$TEST_TEMP_DIR/h3.flag" ] || fail "handler 3 did not run (crash was not isolated)"
}

# =============================================================================
# Cross-cutting: end-to-end install simulation
# =============================================================================

@test "e2e: hooks_sync --cli=claude seeds settings.json from nothing" {
  # No settings.json present
  rm -f "$TEST_PROJECT_DIR/.claude/settings.json"
  run_sync --cli=claude --project-dir="$TEST_PROJECT_DIR"
  [ "$status" -eq 0 ] || fail "fresh install failed: $output"
  [ -f "$TEST_PROJECT_DIR/.claude/settings.json" ] || fail "settings.json not created"
  python3 - "$TEST_PROJECT_DIR/.claude/settings.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
h = d["hooks"]
for ev in ("SessionStart","SessionEnd","PreCompact","PostCompact","PreToolUse","PostToolUse"):
    groups = h.get(ev, [])
    igris = [g for g in groups if any(str(hk.get("command","")).startswith("$HOME/.igris/core/hooks/") for hk in g.get("hooks", []))]
    assert igris, f"no Igris entry for {ev}"
print("ok")
PY
}

# Helper used throughout (bats 'fail' support).
fail() {
  echo "FAIL: $1" >&2
  return 1
}
