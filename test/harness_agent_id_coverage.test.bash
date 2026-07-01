#!/usr/bin/env bats

# harness_agent_id_coverage.test.bash - TD-284 descriptor↔npx agent-id coverage
# drift check (the new verify_mcp arm in check_harness_drift.sh).
#
# The arm asserts every descriptor `agent_id` (read via read_harness_descriptor)
# is PRESENT in add-mcp's supported-agent set (probed via `igris loadout
# list-mcp-agents`). It is GATED on $MCP_DRIFT_ROWS (brain MCP in scope), so these
# fixtures declare a one-target claude MCP block. To test the agent-id arm in
# ISOLATION, IGRIS_CLI is a STUB that returns a controlled list-mcp-agents output
# and exits 0 for the grant + skills arms, and the sandbox ~/.claude.json is
# pre-written with the matching entry so the per-entry mcp drift is MATCH (not
# noise). NO real add-mcp / skills binary and NO real HOME are touched.
#
# Covers the three TD-284 acceptance cases:
#   (a) a descriptor agent-id MISSING from the tool list  -> DRIFT (exit 1).
#   (b) the tool supports MORE than the descriptor         -> clean (exit 0).
#   (c) the probe verb is unavailable (non-zero exit)      -> graceful SKIP (0).

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  GUARD="$ADAPTERS/check_harness_drift.sh"
  [ -f "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  require_python3

  # Sandbox HOME so the projector's default config path ($HOME/.claude.json)
  # lands in temp, never the real machine state.
  SANDBOX_HOME="$TEST_TEMP_DIR/home_$BATS_TEST_NUMBER"
  mkdir -p "$SANDBOX_HOME/.claude"
  export HOME="$SANDBOX_HOME"

  # Isolate the brain dir so the guard does NOT auto-discover the real personal
  # overlay (~/.igris/loadout/harness-manifest.personal.json).
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  PROJ="$TEST_TEMP_DIR/agentid_proj_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ"

  # A project-owned manifest with ONE claude MCP target so $MCP_DRIFT_ROWS is
  # non-empty (the arm's gate). The `harnesses` block is intentionally ABSENT so
  # the guard resolves the REAL repo descriptor (6 agent_ids incl. cursor).
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "mcp_servers": [
      {
        "name": "demo-mcp",
        "canonical": { "command": "node", "args": ["/x/y.js"], "env": {} },
        "targets": [ { "type": "claude", "method": "merge" } ]
      }
    ]
  }
}
EOF

  # Pre-write the claude config with the EXACT normalize_mcp_shape(claude) entry
  # so the per-entry mcp drift is MATCH (structural compare is order-independent).
  cat > "$SANDBOX_HOME/.claude.json" <<'EOF'
{ "mcpServers": { "demo-mcp": { "type": "stdio", "command": "node", "args": ["/x/y.js"], "env": {} } } }
EOF

  # Stub CLI: dispatch on the loadout action ($2). list-mcp-agents cats the
  # controlled fixture + exits $STUB_LIST_RC; grant + skills exit 0 (present/ok).
  STUB="$TEST_TEMP_DIR/cli_stub_$BATS_TEST_NUMBER.sh"
  STUB_AGENTS_FILE="$TEST_TEMP_DIR/stub_agents_$BATS_TEST_NUMBER.txt"
  cat > "$STUB" <<EOF
#!/bin/bash
case "\$2" in
  list-mcp-agents)
    cat "$STUB_AGENTS_FILE" 2>/dev/null
    exit "\${STUB_LIST_RC:-0}"
    ;;
  verify-mcp-grant|project-skills) exit 0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$STUB"
  export IGRIS_CLI="bash $STUB"
}

teardown() {
  unset IGRIS_CLI STUB_LIST_RC
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

run_drift() {
  run bash "$GUARD" --project-root "$PROJ" "$@"
}

# --- (a) descriptor agent-id MISSING from the tool -> DRIFT -----------------

@test "TD-284 (a): a descriptor agent-id absent from add-mcp list-agents is DRIFT" {
  # The tool list omits 'cursor' (a real descriptor agent_id) -> DRIFT for it.
  printf '%s\n' claude-code codex gemini-cli opencode antigravity > "$STUB_AGENTS_FILE"
  run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"[mcp-agents/cursor] DRIFTED"* ]]
  [[ "$output" == *"SILENTLY fail"* ]]
  # The other five ids are supported -> only cursor drifts (no false positives).
  [[ "$output" != *"[mcp-agents/claude-code] DRIFTED"* ]]
}

# --- (b) tool supports MORE than the descriptor -> clean --------------------

@test "TD-284 (b): a tool supporting MORE than the descriptor is NOT drift (clean, exit 0)" {
  # All 6 descriptor ids PLUS extras add-mcp supports (claude-desktop/cline) —
  # the SUBSET check must NOT flag the extras.
  printf '%s\n' claude-code codex gemini-cli opencode antigravity cursor \
    claude-desktop cline goose > "$STUB_AGENTS_FILE"
  run_drift
  [ "$status" -eq 0 ]
  [[ "$output" != *"[mcp-agents/"*"DRIFTED"* ]]
  # The summary counts the agent-id targets as in-sync (no drift/parity).
  [[ "$output" == *"in sync, 0 drifted/missing"* ]]
}

# --- (c) probe unavailable -> graceful SKIP (exit 0) -----------------------

@test "TD-284 (c): an unavailable probe (non-zero exit) SKIPs, never fails the check" {
  # The stub list-mcp-agents exits non-zero (add-mcp not runnable / CLI lacks the
  # verb) -> the arm SKIPs with a notice and does NOT drift.
  : > "$STUB_AGENTS_FILE"
  export STUB_LIST_RC=2
  run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[mcp-agents] SKIP"* ]]
  [[ "$output" != *"[mcp-agents/"*"DRIFTED"* ]]
}

# --- (c') empty probe output also SKIPs ------------------------------------

@test "TD-284 (c'): an empty probe output (exit 0, no ids) also SKIPs" {
  : > "$STUB_AGENTS_FILE"
  export STUB_LIST_RC=0
  run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"[mcp-agents] SKIP"* ]]
}
