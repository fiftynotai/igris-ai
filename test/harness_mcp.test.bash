#!/usr/bin/env bats

# harness_mcp.test.bash - Tests for the FR-164 MCP projection surface.
#
# FR-164 folds MCP servers into the FR-136 manifest-driven engine as a third
# first-class surface (`surfaces.mcp_servers`), projected + drift-checked across
# all 4 harnesses (claude/gemini/opencode/codex). Unlike skills (symlinks), MCP
# projection is a config MERGE delegated to the TS projector (`igris registry
# project-mcp` → mergeJsonConfig/mergeTomlConfig); the bash pass is a thin driver.
#
# These tests are the live e2e (L-135): they actually run compile against
# sandboxed configs, assert the on-disk native shape per harness, then drift,
# then re-compile→MATCH. They cover:
#   1. compile merges an MCP into all 4 configs in NATIVE shape; re-run unchanged.
#   2. no .tmp.* litter beside any config after compile (atomicity).
#   3. malformed codex config → compile FAILs that row; file byte-unchanged;
#      drift reports DRIFTED "unparseable".
#   4. MISSING: a harness with no entry → drift MISSING + non-zero exit.
#   5. DRIFTED: hand-mutated args → drift DRIFTED naming `args` (no value leak);
#      recompile → MATCH.
#   6. ${VAR} ref compare: claude/gemini hold ${VAR}, opencode {env:VAR}, codex
#      the resolved literal; drift output NEVER contains the secret sentinel.
#   7. no-clobber: a hand-registered sibling MCP survives byte-for-byte.
#   8. overlay-merge: a personal mcp_servers block in the isolated overlay is
#      seen by compile/drift (proves the finding #2 merge_overlay_manifest fix).
#   9. shape parity: the bash normalize_mcp_shape matches the TS golden fixture
#      (L-554) for all 4 harnesses.
#  10. core unaffected: an agents+skills run alongside still MATCHes.
#
# Isolation: IGRIS_BRAIN_DIR + a sandboxed HOME so the projector's default
# config paths ($HOME/.claude.json etc.) land in the temp dir, never the real
# machine state. IGRIS_CLI points at the freshly-built CLI (L-552 rebuild first).

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMMON="$ADAPTERS/_common.sh"
  SCHEMA="$ADAPTERS/manifest.schema.json"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"

  [ -f "$COMMON" ] || skip "_common.sh missing at $COMMON"
  [ -f "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  [ -f "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  require_python3

  CLI_ENTRY="$IGRIS_ROOT/cli/dist/index.js"
  [ -f "$CLI_ENTRY" ] || skip "cli/dist/index.js missing — run 'npm run build' in cli/ first (L-552)"
  command -v node >/dev/null 2>&1 || skip "node not available"
  export IGRIS_CLI="node $CLI_ENTRY"

  # Sandbox HOME so the projector's default config paths land in temp.
  SANDBOX_HOME="$TEST_TEMP_DIR/home_$BATS_TEST_NUMBER"
  mkdir -p "$SANDBOX_HOME/.claude" "$SANDBOX_HOME/.gemini" \
    "$SANDBOX_HOME/.codex" "$SANDBOX_HOME/.config/opencode"
  export HOME="$SANDBOX_HOME"

  # Isolate the brain dir (overlay + secrets) from the live machine.
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN/registry"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  SENTINEL="sentinel-secret-DO-NOT-LEAK"
  printf 'API_TOKEN=%s\n' "$SENTINEL" > "$ISOLATED_BRAIN/secrets.env"
  chmod 600 "$ISOLATED_BRAIN/secrets.env"

  PROJ="$TEST_TEMP_DIR/mcp_proj_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ"
  write_manifest

  # Config paths (the projector's defaults, given the sandboxed HOME).
  CLAUDE_CFG="$HOME/.claude.json"
  GEMINI_CFG="$HOME/.gemini/settings.json"
  OPENCODE_CFG="$HOME/.config/opencode/opencode.json"
  CODEX_CFG="$HOME/.codex/config.toml"
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

# Write a project-OWNED base manifest declaring one MCP block, 4 targets.
write_manifest() {
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "mcp_servers": [
      {
        "name": "demo-mcp",
        "canonical": {
          "command": "node",
          "args": ["/x/y.js"],
          "env": { "API": "${API_TOKEN}" },
          "startup_timeout_sec": 30
        },
        "targets": [
          { "type": "claude",   "method": "merge" },
          { "type": "gemini",   "method": "merge" },
          { "type": "opencode", "method": "merge", "enabled": true },
          { "type": "codex",    "method": "merge" }
        ]
      }
    ]
  }
}
EOF
}

# Run compile --surface mcp against the sandbox.
run_compile() {
  bash "$COMPILE" --project-root "$PROJ" --surface mcp "$@"
}

# Run drift against the sandbox.
run_drift() {
  bash "$GUARD" --project-root "$PROJ" "$@"
}

# python helper: read a JSON path key (dotted) from a file.
json_get() {
  python3 -c "import json,sys; d=json.load(open(sys.argv[1]));
k=sys.argv[2].split('.')
for p in k: d=d[p]
print(json.dumps(d))" "$1" "$2"
}

# --- 1. compile native shapes + idempotency --------------------------------

@test "compile projects the MCP into all 4 configs in native shape" {
  run run_compile
  [ "$status" -eq 0 ]

  # claude: type:stdio + ${VAR} ref.
  [ "$(json_get "$CLAUDE_CFG" 'mcpServers.demo-mcp.type')" = '"stdio"' ]
  [ "$(json_get "$CLAUDE_CFG" 'mcpServers.demo-mcp.env.API')" = '"${API_TOKEN}"' ]

  # gemini: NO type + ${VAR} ref.
  run python3 -c "import json; d=json.load(open('$GEMINI_CFG')); print('type' in d['mcpServers']['demo-mcp'])"
  [ "$output" = "False" ]
  [ "$(json_get "$GEMINI_CFG" 'mcpServers.demo-mcp.env.API')" = '"${API_TOKEN}"' ]

  # opencode: type:local + fused command + environment + {env:VAR}.
  [ "$(json_get "$OPENCODE_CFG" 'mcp.demo-mcp.type')" = '"local"' ]
  [ "$(json_get "$OPENCODE_CFG" 'mcp.demo-mcp.command')" = '["node", "/x/y.js"]' ]
  [ "$(json_get "$OPENCODE_CFG" 'mcp.demo-mcp.enabled')" = "true" ]
  [ "$(json_get "$OPENCODE_CFG" 'mcp.demo-mcp.environment.API')" = '"{env:API_TOKEN}"' ]

  # codex: resolved literal (the only harness that reads secrets.env).
  run grep -q "$SENTINEL" "$CODEX_CFG"
  [ "$status" -eq 0 ]
}

@test "compile is idempotent — second run reports unchanged" {
  run_compile >/dev/null 2>&1
  run run_compile
  [ "$status" -eq 0 ]
  [[ "$output" == *"unchanged"* ]]
}

# --- 2. atomicity ----------------------------------------------------------

@test "no .tmp.* litter beside any config after compile" {
  run_compile >/dev/null 2>&1
  run bash -c "find '$HOME' -name '*.tmp.*' -print | head; find '$HOME' -name '*.tmp-*' -print | head"
  [ -z "$output" ]
}

# --- 3. malformed-safe -----------------------------------------------------

@test "malformed codex config → compile FAILs that row, file byte-unchanged" {
  local broken='this is { not valid toml ['
  printf '%s' "$broken" > "$CODEX_CFG"
  run run_compile --target codex
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"mcp/demo-mcp/codex"* ]]
  # File preserved byte-for-byte (mergeTomlConfig never clobbers a malformed file).
  [ "$(cat "$CODEX_CFG")" = "$broken" ]
}

@test "drift reports DRIFTED unparseable for a malformed config" {
  local broken='this is { not valid toml ['
  printf '%s' "$broken" > "$CODEX_CFG"
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"mcp/demo-mcp/codex"* ]]
  [[ "$output" == *"DRIFTED"* ]]
  [[ "$output" == *"unparseable"* ]]
}

# --- 4. MISSING ------------------------------------------------------------

@test "drift reports MISSING for a harness with no entry" {
  # Compile only claude; the other 3 configs are absent → MISSING.
  run_compile --target claude >/dev/null 2>&1
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"mcp/demo-mcp/gemini"* ]]
  [[ "$output" == *"MISSING"* ]]
}

# --- 5. DRIFTED + recompile→MATCH ------------------------------------------

@test "hand-mutated args → drift DRIFTED naming args (no value leak); recompile→MATCH" {
  run_compile >/dev/null 2>&1
  # Mutate claude args by hand.
  python3 -c "import json; p='$CLAUDE_CFG'; d=json.load(open(p)); d['mcpServers']['demo-mcp']['args']=['/tampered.js']; json.dump(d, open(p,'w'))"
  run run_drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"mcp/demo-mcp/claude"* ]]
  [[ "$output" == *"DRIFTED"* ]]
  [[ "$output" == *"args"* ]]
  # No value leak — the tampered path is a non-secret but the contract is "no
  # values"; assert the differing-VALUE string is absent from the reason line.
  [[ "$output" != *"/tampered.js"* ]]

  # Recompile → MATCH.
  run_compile >/dev/null 2>&1
  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"mcp/demo-mcp/claude] MATCH"* ]]
}

# --- 6. ${VAR} ref compare + secret hygiene --------------------------------

@test "drift output NEVER contains the secret sentinel (all 4 harnesses)" {
  run_compile >/dev/null 2>&1
  run run_drift
  [ "$status" -eq 0 ]
  # The drift output must be clean of the secret value for EVERY harness — even
  # codex (which re-resolves the literal internally but prints only key names).
  [[ "$output" != *"$SENTINEL"* ]]
}

@test "claude/gemini/opencode configs hold the REFERENCE (no leaked literal)" {
  run_compile >/dev/null 2>&1
  for f in "$CLAUDE_CFG" "$GEMINI_CFG" "$OPENCODE_CFG"; do
    run grep -q "$SENTINEL" "$f"
    [ "$status" -ne 0 ]
  done
  # codex DOES hold the resolved literal (it resolves nothing at launch).
  run grep -q "$SENTINEL" "$CODEX_CFG"
  [ "$status" -eq 0 ]
}

# --- 7. no-clobber ---------------------------------------------------------

@test "a hand-registered sibling MCP + other top-level keys survive compile" {
  cat > "$CLAUDE_CFG" <<'EOF'
{
  "numStartups": 9,
  "mcpServers": {
    "pencil": { "type": "stdio", "command": "pencil", "args": [], "env": {} }
  }
}
EOF
  run run_compile --target claude
  [ "$status" -eq 0 ]
  [ "$(json_get "$CLAUDE_CFG" 'numStartups')" = "9" ]
  [ "$(json_get "$CLAUDE_CFG" 'mcpServers.pencil.command')" = '"pencil"' ]
  [ "$(json_get "$CLAUDE_CFG" 'mcpServers.demo-mcp.type')" = '"stdio"' ]
}

# --- 8. overlay-merge (finding #2) -----------------------------------------

@test "a personal mcp block in the overlay is seen by compile + drift" {
  # Base manifest with NO mcp_servers; the block lives only in the overlay.
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{ "version": 1, "agents": [] }
EOF
  cat > "$IGRIS_BRAIN_DIR/registry/harness-manifest.personal.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "mcp_servers": [
      {
        "name": "personal-mcp",
        "layer": "personal",
        "canonical": { "command": "node", "args": ["/p.js"], "env": {} },
        "targets": [ { "type": "claude", "method": "merge" } ]
      }
    ]
  }
}
EOF
  run run_compile --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"mcp/personal-mcp/claude"* ]]
  [ "$(json_get "$CLAUDE_CFG" 'mcpServers.personal-mcp.command')" = '"node"' ]

  run run_drift
  [ "$status" -eq 0 ]
  [[ "$output" == *"mcp/personal-mcp/claude] MATCH"* ]]
}

@test "an overlay mcp block colliding with a base block name is a hard error" {
  # Base has demo-mcp; overlay tries to shadow it.
  cat > "$IGRIS_BRAIN_DIR/registry/harness-manifest.personal.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "mcp_servers": [
      {
        "name": "demo-mcp",
        "layer": "personal",
        "canonical": { "command": "evil", "args": [], "env": {} },
        "targets": [ { "type": "claude", "method": "merge" } ]
      }
    ]
  }
}
EOF
  run run_compile --target claude
  [ "$status" -ne 0 ]
  [[ "$output" == *"collides with a base"* ]]
}

# --- 9. shape parity vs the TS golden fixture (L-554) ----------------------

golden_shape_for() {
  # The TS golden REFERENCE shapes (normalize_mcp_shape's stand-in for codex env
  # is the ${VAR} ref, matching the bash helper). bash 3.2-safe (no assoc array).
  case "$1" in
    claude)   echo '{"type":"stdio","command":"node","args":["/x/y.js"],"env":{"API":"${API_TOKEN}"}}' ;;
    gemini)   echo '{"command":"node","args":["/x/y.js"],"env":{"API":"${API_TOKEN}"}}' ;;
    opencode) echo '{"type":"local","command":["node","/x/y.js"],"enabled":true,"environment":{"API":"{env:API_TOKEN}"}}' ;;
    codex)    echo '{"command":"node","args":["/x/y.js"],"env":{"API":"${API_TOKEN}"},"startup_timeout_sec":30}' ;;
  esac
}

@test "normalize_mcp_shape matches the TS golden fixture for all 4 harnesses" {
  # The FIXED canonical — byte-identical to CANONICAL in mcp-shape.test.ts.
  local canon='{"command":"node","args":["/x/y.js"],"env":{"API":"${API_TOKEN}"},"startup_timeout_sec":30}'

  for h in claude gemini opencode codex; do
    actual=$(bash -c "source '$COMMON' >/dev/null 2>&1; normalize_mcp_shape '$canon' '$h' true")
    # Canonicalize BOTH sides with sort_keys so key order does not matter.
    a=$(python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1]), sort_keys=True))" "$actual")
    g=$(python3 -c "import json,sys; print(json.dumps(json.loads(sys.argv[1]), sort_keys=True))" "$(golden_shape_for "$h")")
    if [ "$a" != "$g" ]; then
      echo "PARITY MISMATCH for $h" >&2
      echo "  bash:   $a" >&2
      echo "  golden: $g" >&2
      return 1
    fi
  done
}

# --- 10. core surfaces unaffected ------------------------------------------

@test "an agents-only compile run is unaffected by the MCP pass" {
  # A manifest with one agent and NO mcp_servers; --surface agents must behave
  # exactly as before (no MCP rows, no FAIL from the new pass).
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{ "version": 1, "agents": [], "surfaces": { "mcp_servers": [
  { "name": "demo-mcp",
    "canonical": { "command": "node", "args": [], "env": {} },
    "targets": [ { "type": "claude", "method": "merge" } ] } ] } }
EOF
  # --surface agents must NOT run the MCP pass (no claude.json written).
  run bash "$COMPILE" --project-root "$PROJ" --surface agents
  # No agent targets + agents-only surface → "No ... targets matched" exit 0.
  [ "$status" -eq 0 ]
  [ ! -f "$CLAUDE_CFG" ]
}
