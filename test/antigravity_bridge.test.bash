#!/usr/bin/env bats

# antigravity_bridge.test.bash — FR-181. Tests for the Antigravity hook bridge
# (core/hooks/bridges/antigravity/{pre,post}_tool_use.sh) + the antigravity hook
# drift arm in check_harness_drift.sh.
#
# The bridge translates antigravity's gemini-cli hook stdin
#   { toolCall:{name,args:{TargetFile}}, workspacePaths:[<proj>] }
# into the Igris unified shape the shared pre_tool_use.sh / post_tool_use.sh
# expect, runs the shared gate, and translates its deny-JSON verdict back into
# antigravity's RESPECTED `{decision,reason}` stdout.
#
# Tool-name map (R1 resolved): write_to_file → Write, replace_file_content →
# Edit; both carry the path at args.TargetFile. PostToolUse is always-allow (R2).
#
# Isolation mirrors brief_gate.test.bash: a fresh FAKEHOME + a per-test SQLite
# brain DB. The sandbox dir name avoids the exempt tokens (/test/ /tests/ /core/
# /.igris/ /.claude/) so the gate actually fires for the synthetic file path.
# IGRIS_SHARED_DIR points the bridge at the REPO shared scripts (not the runtime
# mirror) so the test exercises the working-tree bridge + gate together.

load test_helper

setup() {
  REPO_ROOT="$IGRIS_ROOT"
  PRE_BRIDGE="$REPO_ROOT/core/hooks/bridges/antigravity/pre_tool_use.sh"
  POST_BRIDGE="$REPO_ROOT/core/hooks/bridges/antigravity/post_tool_use.sh"
  GUARD="$REPO_ROOT/core/scripts/cli-adapters/check_harness_drift.sh"
  COMMON="$REPO_ROOT/core/scripts/cli-adapters/_common.sh"
  [ -f "$PRE_BRIDGE" ] || { echo "pre bridge not found at $PRE_BRIDGE"; return 1; }
  [ -f "$POST_BRIDGE" ] || { echo "post bridge not found at $POST_BRIDGE"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"

  # `agb` is short + token-free (avoids the exempt-path tokens).
  # FR-212c: realpath-normalise (cd && pwd -P) so the registered projects.path
  # matches the registration gate's `pwd -P` resolution (macOS /tmp ->
  # /private/tmp); otherwise the gate sees the project as unregistered and
  # no-ops the brief-gate (allow) instead of denying a no-brief write.
  SANDBOX="$(cd "$(mktemp -d "${BATS_TMPDIR:-/tmp}/agb.XXXXXX")" && pwd -P)"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"

  PROJ="$SANDBOX/myproj"
  mkdir -p "$PROJ/src"

  # The bridge runs the REPO shared gate via IGRIS_SHARED_DIR.
  export IGRIS_SHARED_DIR="$REPO_ROOT/core/hooks/shared"

  sqlite3 "$DB" "
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, tech_stack TEXT,
      igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, brief_type TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT, effort TEXT, phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL,
      component TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT, project_slug TEXT, instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
}

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# run_pre <tool_name> <target_file> [extra env...]
#   Drives the PreToolUse bridge with an antigravity-shaped payload.
run_pre() {
  local tool="$1" tfile="$2"; shift 2
  run bash -c "printf '%s' '{\"toolCall\":{\"name\":\"$tool\",\"args\":{\"TargetFile\":\"$tfile\"}},\"workspacePaths\":[\"$PROJ\"]}' | HOME='$FAKEHOME' $* bash '$PRE_BRIDGE' 2>/dev/null"
}

# -----------------------------------------------------------------------------
# (1) write_to_file → Write; no active brief, non-exempt path → DENY.
# -----------------------------------------------------------------------------
@test "(1) write_to_file to non-exempt path, no brief -> deny" {
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');"
  run_pre "write_to_file" "$PROJ/src/app.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision": "deny"'* ]] || [[ "$output" == *'"decision":"deny"'* ]]
  [[ "$output" == *"No active brief"* ]]
}

# -----------------------------------------------------------------------------
# (2) write_to_file → Write; ACTIVE brief → ALLOW.
# -----------------------------------------------------------------------------
@test "(2) write_to_file with an active brief -> allow" {
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');
    INSERT INTO brief_status (project,brief_id,title,status)
      VALUES ('myproj','FR-181','t','In Progress');
  "
  run_pre "write_to_file" "$PROJ/src/app.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision": "allow"'* ]] || [[ "$output" == *'"decision":"allow"'* ]]
  [[ "$output" != *"deny"* ]]
}

# -----------------------------------------------------------------------------
# (3) replace_file_content → Edit; no brief, non-exempt path → DENY (the edit
#     tool maps to Edit and carries the path at args.TargetFile).
# -----------------------------------------------------------------------------
@test "(3) replace_file_content to non-exempt path, no brief -> deny" {
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');"
  run_pre "replace_file_content" "$PROJ/src/app.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision": "deny"'* ]] || [[ "$output" == *'"decision":"deny"'* ]]
}

# -----------------------------------------------------------------------------
# (4) Exempt path (~/.igris/...) → ALLOW even with no brief.
# -----------------------------------------------------------------------------
@test "(4) exempt path (~/.igris/...) -> allow regardless of brief" {
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');"
  run_pre "write_to_file" "$FAKEHOME/.igris/core/x.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision": "allow"'* ]] || [[ "$output" == *'"decision":"allow"'* ]]
}

# -----------------------------------------------------------------------------
# (5) Non-file tool (run_command) → empty file_path → ALLOW (gate only acts on
#     the file path; a non-Write/Edit tool is never gated).
# -----------------------------------------------------------------------------
@test "(5) non-file tool (run_command) -> allow (empty file_path)" {
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');"
  run bash -c "printf '%s' '{\"toolCall\":{\"name\":\"run_command\",\"args\":{\"Command\":\"ls\"}},\"workspacePaths\":[\"$PROJ\"]}' | HOME='$FAKEHOME' bash '$PRE_BRIDGE' 2>/dev/null"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision": "allow"'* ]] || [[ "$output" == *'"decision":"allow"'* ]]
}

# -----------------------------------------------------------------------------
# (6) IGRIS_BYPASS_BRIEF_GATE=1 → ALLOW (escape hatch flows through the bridge).
# -----------------------------------------------------------------------------
@test "(6) IGRIS_BYPASS_BRIEF_GATE=1 -> allow" {
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');"
  run_pre "write_to_file" "$PROJ/src/app.ts" "IGRIS_BYPASS_BRIEF_GATE=1"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision": "allow"'* ]] || [[ "$output" == *'"decision":"allow"'* ]]
}

# -----------------------------------------------------------------------------
# (7) PostToolUse → always ALLOW (fire-and-forget; never a gate), even with no
#     brief and a non-exempt write.
# -----------------------------------------------------------------------------
@test "(7) PostToolUse -> always allow" {
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');"
  run bash -c "printf '%s' '{\"toolCall\":{\"name\":\"write_to_file\",\"args\":{\"TargetFile\":\"$PROJ/src/app.ts\"}},\"workspacePaths\":[\"$PROJ\"]}' | HOME='$FAKEHOME' bash '$POST_BRIDGE' 2>/dev/null"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision":"allow"'* ]]
}

# -----------------------------------------------------------------------------
# (8) Malformed stdin → fail-open ALLOW (never crash the host CLI).
# -----------------------------------------------------------------------------
@test "(8) malformed stdin -> fail-open allow" {
  run bash -c "printf '%s' '{ not json' | HOME='$FAKEHOME' bash '$PRE_BRIDGE' 2>/dev/null"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision": "allow"'* ]] || [[ "$output" == *'"decision":"allow"'* ]]
}

# -----------------------------------------------------------------------------
# (9) Drift arm: the antigravity hook drift verdict via verify_hook_entry_present
#     reads ~/.gemini/config/hooks.json (the IGRIS_HOOK_ANTIGRAVITY_CONFIG seam).
#     Present command → MATCH; absent → MISSING.
# -----------------------------------------------------------------------------
@test "(9) drift arm: present hook -> MATCH, absent -> MISSING" {
  CMD="\$HOME/.igris/core/hooks/bridges/antigravity/pre_tool_use.sh"
  AG_HOOKS="$SANDBOX/hooks.json"

  # Absent file → MISSING.
  local v_missing
  v_missing=$(bash -c "source '$COMMON' >/dev/null 2>&1; verify_hook_entry_present '$AG_HOOKS' 'PreToolUse' '$CMD'")
  [ "$v_missing" = "MISSING" ]

  # Write a gemini-cli-format hooks.json carrying our command → MATCH.
  cat > "$AG_HOOKS" <<EOF
{ "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "$CMD" } ] } ] } }
EOF
  local v_match
  v_match=$(bash -c "source '$COMMON' >/dev/null 2>&1; verify_hook_entry_present '$AG_HOOKS' 'PreToolUse' '$CMD'")
  [ "$v_match" = "MATCH" ]
}
