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

# ---------------------------------------------------------------------------
# FR-149: claude as a first-class skills target type (claude/symlink).
# Schema-level checks: the new (type, method) pair is accepted, and the
# invalid pair combinations are rejected at schema validation.
# ---------------------------------------------------------------------------

@test "FR-149: schema accepts claude/symlink skill target" {
  cat > "$PROJ/ok-claude.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "claude", "method": "symlink", "path": "~/.claude/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-claude.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-149: schema rejects claude/compiler skill target (bad pair)" {
  cat > "$PROJ/bad-claude-compiler.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "claude", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-claude-compiler.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"claude"* || "$output" == *"oneOf"* ]]
}

@test "FR-151: schema ACCEPTS codex/symlink skill target (widened allowlist)" {
  # FR-149 originally rejected codex/symlink; FR-151 widens the allowlist to
  # admit codex/symlink + gemini/symlink for the unified harness work (the
  # legacy codex/compiler + gemini/converter stay valid until FR-153 retires
  # them). See L-519, FR-151.
  cat > "$PROJ/ok-codex-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "codex", "method": "symlink", "path": "~/.codex/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-codex-symlink.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-149: schema rejects claude/converter skill target (bad pair)" {
  cat > "$PROJ/bad-claude-converter.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "claude", "method": "converter", "path": "x" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-claude-converter.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"claude"* || "$output" == *"oneOf"* ]]
}

@test "FR-149: structural fallback rejects claude/compiler skill target" {
  # Forces the no-jsonschema path so the structural-fallback's pair-allowlist
  # is the one under test (the jsonschema path agrees via `oneOf`).
  local blockdir="$PROJ/noimport"
  mkdir -p "$blockdir"
  cat > "$blockdir/sitecustomize.py" <<'PY'
import sys
class _Blocker:
    def find_module(self, name, path=None):
        if name == "jsonschema":
            return self
        return None
    def load_module(self, name):
        raise ImportError("jsonschema blocked for test")
sys.meta_path.insert(0, _Blocker())
PY
  cat > "$PROJ/bad-claude-compiler.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "claude", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/bad-claude-compiler.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"claude"* ]]
}

# ---------------------------------------------------------------------------
# FR-151: widen the (type, method) pair allowlist to include codex/symlink +
# gemini/symlink. The legacy codex/compiler + gemini/converter remain valid
# back-compat until FR-153 retires them. See L-519, FR-151.
# ---------------------------------------------------------------------------

@test "FR-151: schema accepts gemini/symlink skill target" {
  cat > "$PROJ/ok-gemini-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "gemini", "method": "symlink", "path": "~/.gemini/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-gemini-symlink.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-151: schema still accepts legacy codex/compiler (back-compat)" {
  # FR-153 retires this pair; until then it MUST remain valid so existing
  # personal overlays don't break mid-transition.
  cat > "$PROJ/ok-codex-compiler.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-codex-compiler.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-151: schema still accepts legacy gemini/converter (back-compat)" {
  cat > "$PROJ/ok-gemini-converter.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "gemini", "method": "converter", "path": "out" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-gemini-converter.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-151: schema rejects gemini/compiler skill target (still invalid)" {
  # gemini/compiler is NOT in the allowlist (gemini is converter-method OR
  # symlink-method; compiler is codex's legacy method).
  cat > "$PROJ/bad-gemini-compiler.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "gemini", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-gemini-compiler.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"gemini"* || "$output" == *"oneOf"* ]]
}

@test "FR-151: structural fallback accepts codex/symlink + gemini/symlink" {
  # Forces the no-jsonschema path so the structural-fallback's pair-allowlist
  # is under test. Both new pairs must be accepted via valid_pairs.
  local blockdir="$PROJ/noimport"
  mkdir -p "$blockdir"
  cat > "$blockdir/sitecustomize.py" <<'PY'
import sys
class _Blocker:
    def find_module(self, name, path=None):
        if name == "jsonschema":
            return self
        return None
    def load_module(self, name):
        raise ImportError("jsonschema blocked for test")
sys.meta_path.insert(0, _Blocker())
PY
  cat > "$PROJ/ok-codex-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "codex", "method": "symlink", "path": "~/.codex/skills" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/ok-codex-symlink.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
  cat > "$PROJ/ok-gemini-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "gemini", "method": "symlink", "path": "~/.gemini/skills" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/ok-gemini-symlink.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}
