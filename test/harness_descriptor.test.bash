#!/usr/bin/env bats

# harness_descriptor.test.bash — FR-217 (harness-wiring consolidation).
#
# Covers the bash side of the canonical harness descriptor:
#   1. read_harness_descriptor — the ONE bash reader (the bash twin of
#      cli/src/lib/harness-descriptor.ts). List + field-lookup queries.
#   2. validate_manifest schema<->descriptor cross-check (§4): each schema
#      harness-enum MUST equal the descriptor-derived set; a mutated schema is a
#      HARD fail.
#   3. The drift parity guard (§5, M4): the TD-228 class — an agent that projects
#      to SOME agent-target-row harnesses but DROPPED one is flagged PARITY; a
#      complete-row agent (incl. antigravity correctly absent) is NOT.
#
# The validation runs the STRUCTURAL fallback path on machines without the
# `jsonschema` python module (the common case here); the cross-check runs in
# BOTH paths.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMMON="$ADAPTERS/_common.sh"
  SCHEMA="$ADAPTERS/manifest.schema.json"
  GUARD="$ADAPTERS/check_harness_drift.sh"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  DESCRIPTOR="$IGRIS_ROOT/harness-manifest.json"

  [ -f "$COMMON" ] || skip "_common.sh missing at $COMMON"
  [ -f "$SCHEMA" ] || skip "manifest.schema.json missing at $SCHEMA"
  [ -f "$DESCRIPTOR" ] || skip "harness-manifest.json missing at $DESCRIPTOR"
  require_python3

  # Isolate from the live brain dir so the guard/compile do NOT auto-discover the
  # user's personal overlay manifest (which would merge synthetic-root tests).
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  PROJ="$TEST_TEMP_DIR/harness_descriptor_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ/canon" "$PROJ/.claude/agents"

  cat > "$PROJ/canon/sample.md" <<'EOF'
---
name: sample
description: a sample canonical agent prompt
---

# SAMPLE AGENT

Canonical body.
EOF
}

# Write a project manifest declaring ONE agent named "forger" with the given
# JSON targets array (so the parity guard has a CORE-named agent to examine).
write_forger_with_targets() {
  local targets_json="$1"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [
    {
      "name": "forger",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": $targets_json
    }
  ]
}
EOF
}

# --- 1. read_harness_descriptor ---------------------------------------------

@test "read_harness_descriptor: harness_ids lists all 5 in declaration order" {
  run bash -c "source '$COMMON' && read_harness_descriptor '$DESCRIPTOR' harness_ids"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | tr '\n' ',')" = "claude,codex,gemini,opencode,antigravity" ]
}

@test "read_harness_descriptor: agent_ids maps claude->claude-code, gemini->gemini-cli" {
  run bash -c "source '$COMMON' && read_harness_descriptor '$DESCRIPTOR' agent_ids"
  [ "$status" -eq 0 ]
  [[ "$output" == *"claude-code"* ]]
  [[ "$output" == *"gemini-cli"* ]]
  [[ "$output" != *$'\ngemini\n'* ]]
}

@test "read_harness_descriptor: agent_target_row_harnesses = {codex,gemini,opencode} (claude symlink + antigravity excluded)" {
  run bash -c "source '$COMMON' && read_harness_descriptor '$DESCRIPTOR' agent_target_row_harnesses"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | tr '\n' ',')" = "codex,gemini,opencode" ]
}

@test "read_harness_descriptor: hook_target_types = {claude,opencode,antigravity}" {
  run bash -c "source '$COMMON' && read_harness_descriptor '$DESCRIPTOR' hook_target_types"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | tr '\n' ',')" = "claude,opencode,antigravity" ]
}

@test "read_harness_descriptor: grant_harnesses = all 5; field lookups resolve" {
  run bash -c "source '$COMMON' && read_harness_descriptor '$DESCRIPTOR' grant_harnesses"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -c .)" = "5" ]
  run bash -c "source '$COMMON' && read_harness_descriptor '$DESCRIPTOR' 'grant_path:antigravity'"
  [ "$status" -eq 0 ]
  [ "$output" = "~/.gemini/antigravity-cli/settings.json" ]
  run bash -c "source '$COMMON' && read_harness_descriptor '$DESCRIPTOR' 'mcp_config_path:codex'"
  [ "$status" -eq 0 ]
  [ "$output" = "~/.codex/config.toml" ]
}

@test "read_harness_descriptor: an unknown query is a hard error" {
  run bash -c "source '$COMMON' && read_harness_descriptor '$DESCRIPTOR' bogus_query"
  [ "$status" -ne 0 ]
}

# --- 2. schema <-> descriptor cross-check (§4) ------------------------------

@test "validate_manifest: a valid manifest passes (schema enums agree with descriptor)" {
  write_forger_with_targets '[ { "type": "claude", "path": ".claude/agents/forger.md" } ]'
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/harness-manifest.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "validate_manifest: a schema whose mcp harness-enum diverges from the descriptor is a HARD fail" {
  # Drop antigravity from the schema's mcp-surface target enum → it no longer
  # equals the descriptor's mcp set (all 5). The cross-check must reject.
  local drifted="$PROJ/drifted-schema.json"
  python3 - "$SCHEMA" "$drifted" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
e = s["$defs"]["mcp_surface"]["properties"]["targets"]["items"]["properties"]["type"]["enum"]
s["$defs"]["mcp_surface"]["properties"]["targets"]["items"]["properties"]["type"]["enum"] = [x for x in e if x != "antigravity"]
json.dump(s, open(sys.argv[2], "w"))
PY
  write_forger_with_targets '[ { "type": "claude", "path": ".claude/agents/forger.md" } ]'
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/harness-manifest.json' '$drifted'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"schema<->descriptor drift"* ]]
  [[ "$output" == *"mcp target"* ]]
}

@test "validate_manifest: a schema whose agent harness-enum diverges from the descriptor is a HARD fail" {
  local drifted="$PROJ/drifted-schema2.json"
  python3 - "$SCHEMA" "$drifted" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
e = s["$defs"]["agent"]["properties"]["targets"]["items"]["properties"]["type"]["enum"]
s["$defs"]["agent"]["properties"]["targets"]["items"]["properties"]["type"]["enum"] = [x for x in e if x != "gemini"]
json.dump(s, open(sys.argv[2], "w"))
PY
  write_forger_with_targets '[ { "type": "claude", "path": ".claude/agents/forger.md" } ]'
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/harness-manifest.json' '$drifted'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"schema<->descriptor drift"* ]]
  [[ "$output" == *"agents target"* ]]
}

# --- 3. drift parity guard (§5, M4) -----------------------------------------

@test "parity (TD-228 shape): a sibling has gemini, forger DROPPED it → PARITY + non-zero" {
  # The literal TD-228 shape: 'architect' projects to all 3 row-harnesses, but
  # 'forger' dropped gemini. The manifest footprint therefore includes gemini, so
  # forger's strict-subset row set is the anomaly. The per-target drift can't see
  # the dropped target; parity can.
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "architect",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [
        { "type": "codex",    "path": ".codex/agents/architect.toml" },
        { "type": "gemini",   "path": "~/.gemini/agents/architect.md" },
        { "type": "opencode", "path": "~/.config/opencode/agent/architect.md" }
      ]
    },
    {
      "name": "forger",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [
        { "type": "codex",    "path": ".codex/agents/forger.toml" },
        { "type": "opencode", "path": "~/.config/opencode/agent/forger.md" }
      ]
    }
  ]
}
EOF
  run bash "$GUARD" --project-root "$PROJ" --surface agents
  [ "$status" -ne 0 ]
  [[ "$output" == *"[forger/gemini] PARITY"* ]]
  [[ "$output" != *"[architect/"*"PARITY"* ]]
  [[ "$output" == *"parity violation"* ]]
}

@test "parity (intentional single-row project): a codex-only agent is NOT flagged" {
  # No sibling establishes gemini/opencode as expected → the manifest footprint is
  # just {codex} → the codex-only agent is consistent, NOT a parity miss. This is
  # the false-positive class the footprint heuristic forecloses (the synthetic
  # single-harness fixtures the existing drift suites rely on).
  write_forger_with_targets '[ { "type": "codex", "path": ".codex/agents/forger.toml" } ]'
  run bash "$GUARD" --project-root "$PROJ" --surface agents
  [[ "$output" != *"PARITY"* ]]
}

@test "parity (antigravity correctly absent): full-row agent {codex,gemini,opencode} → NO PARITY false-positive" {
  # The OPEN-DECISION #1 boundary: antigravity has no agents block → it is NOT an
  # expected agent-row harness, so its absence must NOT be flagged.
  write_forger_with_targets '[
    { "type": "codex",    "path": ".codex/agents/forger.toml" },
    { "type": "gemini",   "path": "~/.gemini/agents/forger.md" },
    { "type": "opencode", "path": "~/.config/opencode/agent/forger.md" }
  ]'
  run bash "$GUARD" --project-root "$PROJ" --surface agents
  [[ "$output" != *"PARITY"* ]]
}

@test "parity (clean compiled run): claude agent compiles to MATCH → exit 0, no PARITY" {
  # A claude-only agent has ZERO row-harnesses → an intentional non-row projection,
  # never a parity miss. Compiled, it is MATCH → exit 0 with no parity noise (the
  # byte-identical-clean baseline).
  write_forger_with_targets '[ { "type": "claude", "path": ".claude/agents/forger.md" } ]'
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ" --surface agents
  [ "$status" -eq 0 ]
  [[ "$output" == *"[forger/claude] MATCH"* ]]
  [[ "$output" != *"PARITY"* ]]
}
