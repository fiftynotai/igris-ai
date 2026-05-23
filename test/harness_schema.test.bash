#!/usr/bin/env bats

# harness_schema.test.bash - Tests for the FR-136 manifest schema + validation
# + base/overlay merge seam.
#
# Covers:
#   - validate_manifest rejects malformed manifests (missing targets, bad
#     target type enum, versioned-glob/unversioned-file oneOf, unknown
#     top-level key, version != 1) with a clear, non-zero error.
#   - validate_manifest accepts a well-formed manifest.
#   - FR-136 manifest resolution: <project-root>/harness-manifest.json is the
#     default; --manifest overrides; a missing manifest fails with the
#     actionable "harness manifest not found ... pass --manifest" error.
#   - base+overlay merge adds overlay agents; a name collision is a hard error.
#   - idempotent byte-identical compile (claude path).
#
# The validation runs the STRUCTURAL fallback path on machines without the
# `jsonschema` python module (the common case); if jsonschema is installed the
# same assertions hold via the schema-validation path.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMMON="$ADAPTERS/_common.sh"
  SCHEMA="$ADAPTERS/manifest.schema.json"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"

  [ -f "$COMMON" ] || skip "_common.sh missing at $COMMON"
  [ -f "$SCHEMA" ] || skip "manifest.schema.json missing at $SCHEMA"
  require_python3

  # Isolate from the live brain dir so the guard/compile do NOT
  # auto-discover the user's personal overlay manifest at
  # ~/.igris/registry/harness-manifest.personal.json (FR-146 leaves this in
  # place between runs; without isolation it merges into every test's
  # manifest and breaks synthetic-root tests).
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  PROJ="$TEST_TEMP_DIR/harness_schema_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ/canon" "$PROJ/.claude/agents"

  cat > "$PROJ/canon/sample.md" <<'EOF'
---
name: sample
description: a sample canonical agent prompt
---

# SAMPLE AGENT

Canonical body. Must match the harness body exactly.
EOF

  cat > "$PROJ/.claude/agents/sample.md" <<'EOF'
---
name: sample
description: harness frontmatter (preserved on sync)
---

placeholder
EOF

  # A valid base manifest at the project root (FR-136 default location).
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [
        { "type": "claude", "path": ".claude/agents/sample.md" }
      ]
    }
  ]
}
EOF
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

# --- validate_manifest: accept a valid manifest -----------------------------

@test "validate_manifest accepts a well-formed manifest (exit 0)" {
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/harness-manifest.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

# --- Scenario 1: missing targets --------------------------------------------

@test "schema rejects a manifest with an agent missing 'targets'" {
  cat > "$PROJ/bad.json" <<'EOF'
{
  "version": 1,
  "agents": [
    { "name": "sample", "canonical": { "dir": "canon", "file": "sample.md", "versioned": false } }
  ]
}
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"targets"* ]]
}

# --- Scenario 2: bad target type enum ---------------------------------------

@test "schema rejects a bad target 'type' enum value" {
  cat > "$PROJ/bad.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [ { "type": "opencode", "path": ".x/sample.md" } ]
    }
  ]
}
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"opencode"* || "$output" == *"type"* ]]
}

# --- Scenario 3a: versioned=true without glob -------------------------------

@test "schema rejects versioned=true without 'glob'" {
  cat > "$PROJ/bad.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "versioned": true },
      "targets": [ { "type": "claude", "path": ".claude/agents/sample.md" } ]
    }
  ]
}
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"glob"* ]]
}

# --- Scenario 3b: versioned=false without file ------------------------------

@test "schema rejects versioned=false without 'file'" {
  cat > "$PROJ/bad.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "versioned": false },
      "targets": [ { "type": "claude", "path": ".claude/agents/sample.md" } ]
    }
  ]
}
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"file"* ]]
}

# --- Scenario 4: unknown top-level key (typo) -------------------------------

@test "schema rejects an unknown top-level key (additionalProperties:false)" {
  cat > "$PROJ/bad.json" <<'EOF'
{
  "version": 1,
  "agentz": [],
  "agents": []
}
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"agentz"* || "$output" == *"unknown"* || "$output" == *"additional"* ]]
}

# --- version != 1 -----------------------------------------------------------

@test "schema rejects version != 1" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 2, "agents": [] }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"version"* ]]
}

# --- FR-136 manifest resolution ---------------------------------------------

@test "compile resolves <project-root>/harness-manifest.json by default" {
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"sample/claude"* ]]
}

@test "compile fails with an actionable error when no manifest is found" {
  local bare="$TEST_TEMP_DIR/bare_$BATS_TEST_NUMBER"
  mkdir -p "$bare"
  run bash "$COMPILE" --project-root "$bare" --target claude
  [ "$status" -ne 0 ]
  [[ "$output" == *"harness manifest not found"* ]]
  [[ "$output" == *"--manifest"* ]]
}

@test "compile honors an explicit --manifest override" {
  mv "$PROJ/harness-manifest.json" "$PROJ/custom.json"
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/custom.json" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"sample/claude"* ]]
}

# --- Overlay merge ----------------------------------------------------------

@test "overlay merge adds an extra agent to the work set" {
  # Second canonical + target for the overlay agent.
  cp "$PROJ/canon/sample.md" "$PROJ/canon/extra.md"
  cp "$PROJ/.claude/agents/sample.md" "$PROJ/.claude/agents/extra.md"
  cat > "$PROJ/overlay.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "extra",
      "canonical": { "dir": "canon", "file": "extra.md", "versioned": false },
      "targets": [ { "type": "claude", "path": ".claude/agents/extra.md" } ]
    }
  ]
}
EOF
  run bash "$COMPILE" --project-root "$PROJ" --overlay "$PROJ/overlay.json" --target claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"sample/claude"* ]]
  [[ "$output" == *"extra/claude"* ]]
  [[ "$output" == *"2 targets"* ]]
}

@test "overlay name collision with a base agent is a hard error" {
  cat > "$PROJ/overlay.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [ { "type": "claude", "path": ".claude/agents/sample.md" } ]
    }
  ]
}
EOF
  run bash "$COMPILE" --project-root "$PROJ" --overlay "$PROJ/overlay.json" --target claude
  [ "$status" -ne 0 ]
  [[ "$output" == *"collides"* || "$output" == *"shadow"* ]]
}

# --- Idempotent compile (claude path) ---------------------------------------

@test "compile is idempotent (byte-identical on a second run)" {
  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  local first
  first="$(cat "$PROJ/.claude/agents/sample.md")"

  run bash "$COMPILE" --project-root "$PROJ" --target claude
  [ "$status" -eq 0 ]
  local second
  second="$(cat "$PROJ/.claude/agents/sample.md")"

  [ "$first" = "$second" ]
}
