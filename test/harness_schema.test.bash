#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
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
  # ~/.igris/loadout/harness-manifest.personal.json (FR-146 leaves this in
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

  # FR-152: claude target is a loadout-anchored symlink the compiler creates.
  # No pre-authored real harness file (that was the FR-149-era Case C path,
  # retired by FR-152; pre-creating one would now hard-error refuse-to-clobber).

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
  cleanup_test_temp_dir
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
      "targets": [ { "type": "bogus", "path": ".x/sample.md" } ]
    }
  ]
}
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"bogus"* || "$output" == *"type"* ]]
}

@test "FR-171: schema accepts an opencode agent target 'type' enum value" {
  cat > "$PROJ/ok.json" <<'EOF'
{
  "version": 1,
  "agents": [
    {
      "name": "sample",
      "canonical": { "dir": "canon", "file": "sample.md", "versioned": false },
      "targets": [ { "type": "opencode", "path": "~/.config/opencode/agent/sample.md" } ]
    }
  ]
}
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
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

# FR-202 M4: the os_identity SURFACE was retired (no plugin, no $defs). A stray
# surfaces.os_identity block must FAIL validation (additionalProperties:false on
# `surfaces`), NOT silently pass-then-no-op — the §13 phantom-surface guard.
@test "schema rejects a stray surfaces.os_identity block (FR-202 M4 retired the surface)" {
  cat > "$PROJ/bad.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "os_identity": [
      { "targets": [ { "type": "gemini", "method": "file", "filename": "GEMINI.md" } ] }
    ]
  }
}
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"os_identity"* || "$output" == *"unknown"* || "$output" == *"additional"* ]]
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
  # Second canonical for the overlay agent. FR-152: the claude target is a
  # symlink the compiler creates atomically — no pre-authored real file.
  cp "$PROJ/canon/sample.md" "$PROJ/canon/extra.md"
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

@test "FR-202 M1: schema REJECTS codex/symlink skill target (dead branch removed)" {
  # FR-151 once widened the allowlist to admit codex/symlink + gemini/symlink.
  # FR-202 (M1) deleted those dead standalone targets — codex+gemini read the
  # `agents/symlink` projection natively (FR-157), so they need no standalone
  # skill target. No live manifest declared the pair. See L-519, FR-202.
  cat > "$PROJ/bad-codex-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "codex", "method": "symlink", "path": "~/.codex/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-codex-symlink.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"codex"* || "$output" == *"pair"* || "$output" == *"oneOf"* ]]
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
# FR-202 (M1): the skills (type, method) pair allowlist is narrowed to the live
# triad (claude/symlink, agents/symlink, opencode/command). The dead standalone
# codex/symlink + gemini/symlink targets (superseded by agents/symlink under
# FR-157) and the long-retired codex/compiler + gemini/converter methods were
# dropped. See L-519, FR-202.
# ---------------------------------------------------------------------------

@test "FR-202 M1: schema REJECTS gemini/symlink skill target (dead branch removed)" {
  cat > "$PROJ/bad-gemini-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "gemini", "method": "symlink", "path": "~/.gemini/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-gemini-symlink.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gemini"* || "$output" == *"pair"* || "$output" == *"oneOf"* ]]
}

@test "FR-202 M1: schema ACCEPTS agents/symlink skill target (the live cross-CLI target)" {
  cat > "$PROJ/ok-agents-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-agents-symlink.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-153: schema REJECTS legacy codex/compiler (tightening)" {
  # FR-153 retires this pair; the schema's pair allowlist no longer accepts
  # codex/compiler. Personal overlays with the legacy pair must fail
  # validation immediately so the operator knows to migrate.
  cat > "$PROJ/bad-codex-compiler.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-codex-compiler.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"compiler"* || "$output" == *"oneOf"* ]]
}

@test "FR-153: schema REJECTS legacy gemini/converter (tightening)" {
  cat > "$PROJ/bad-gemini-converter.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "gemini", "method": "converter", "path": "out" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-gemini-converter.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"converter"* || "$output" == *"oneOf"* ]]
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

@test "FR-202 M1: structural fallback REJECTS codex/symlink + gemini/symlink (narrowed), ACCEPTS agents/symlink" {
  # Forces the no-jsonschema path so the structural-fallback's pair-allowlist
  # is under test. The dead codex/symlink + gemini/symlink pairs must now be
  # rejected; the live agents/symlink target must be accepted. See FR-202 M1.
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
  cat > "$PROJ/bad-codex-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "codex", "method": "symlink", "path": "~/.codex/skills" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/bad-codex-symlink.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  cat > "$PROJ/bad-gemini-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "gemini", "method": "symlink", "path": "~/.gemini/skills" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/bad-gemini-symlink.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  cat > "$PROJ/ok-agents-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/ok-agents-symlink.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-153: structural fallback REJECTS codex/compiler + gemini/converter (tightening)" {
  # Forces the no-jsonschema path so the structural-fallback's pair-allowlist
  # tightening is under test. Both retired pairs must fail validation.
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
  cat > "$PROJ/bad-codex-compiler.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/bad-codex-compiler.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"compiler"* ]]
  cat > "$PROJ/bad-gemini-converter.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "gemini", "method": "converter", "path": "out" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/bad-gemini-converter.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"converter"* ]]
}

# ---------------------------------------------------------------------------
# FR-157: `agents` as a fourth skills target type (agents/symlink) — the
# cross-CLI shared `~/.agents/skills/` standard. Schema-level checks: the new
# (type, method) pair is accepted, invalid pair combinations are rejected.
# ---------------------------------------------------------------------------

@test "FR-157: schema accepts agents/symlink skill target" {
  cat > "$PROJ/ok-agents-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-agents-symlink.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-157: schema rejects agents/compiler skill target (bad pair)" {
  cat > "$PROJ/bad-agents-compiler.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "agents", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-agents-compiler.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"agents"* || "$output" == *"oneOf"* ]]
}

@test "FR-157: schema rejects agents/converter skill target (bad pair)" {
  cat > "$PROJ/bad-agents-converter.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "agents", "method": "converter", "path": "out" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-agents-converter.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"agents"* || "$output" == *"oneOf"* ]]
}

@test "FR-157: structural fallback accepts agents/symlink and rejects agents/compiler" {
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
  cat > "$PROJ/ok-agents-symlink.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "agents", "method": "symlink", "path": "~/.agents/skills" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/ok-agents-symlink.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
  cat > "$PROJ/bad-agents-compiler.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "agents", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/bad-agents-compiler.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pair"* || "$output" == *"agents"* ]]
}

# ---------------------------------------------------------------------------
# FR-179: antigravity joins the MCP target enum ONLY. It must be ACCEPTED as an
# mcp_servers target, but REJECTED on every other surface (skills/agents/
# identity/hooks) — proving the deliberate non-widening of those enums.
# ---------------------------------------------------------------------------

@test "FR-179: schema ACCEPTS an antigravity MCP target" {
  cat > "$PROJ/ok-ag-mcp.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "mcp_servers": [
    { "name": "demo-mcp",
      "canonical": { "command": "node", "args": ["/x/y.js"], "env": {} },
      "targets": [ { "type": "antigravity", "method": "merge" } ] } ] } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-ag-mcp.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-179: schema REJECTS antigravity as a SKILL target (non-widening)" {
  cat > "$PROJ/bad-ag-skill.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills", "layer": "core",
    "targets": [ { "type": "antigravity", "method": "symlink", "path": "~/.agents/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-ag-skill.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"antigravity"* || "$output" == *"enum"* || "$output" == *"pair"* || "$output" == *"oneOf"* ]]
}

@test "FR-179: schema REJECTS antigravity as an AGENT target (non-widening)" {
  # The agent block is otherwise STRUCTURALLY VALID (name + canonical{dir,
  # versioned:false,file} + a targets array) — so the rejection isolates on the
  # antigravity target `type`, not a missing-field artifact.
  cat > "$PROJ/bad-ag-agent.json" <<'EOF'
{ "version": 1,
  "agents": [ { "name": "demo",
    "canonical": { "dir": "agents", "versioned": false, "file": "demo.md" },
    "targets": [ { "type": "antigravity", "path": "~/x/demo.md" } ] } ],
  "surfaces": {} }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-ag-agent.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"antigravity"* || "$output" == *"enum"* || "$output" == *"type"* || "$output" == *"oneOf"* ]]
}

# ---------------------------------------------------------------------------
# FR-181: antigravity JOINS the HOOK target enum (config-merge into
# ~/.gemini/config/hooks.json via the bridge). It must be ACCEPTED as a hook
# target — while still REJECTED as skill/agent/identity (FR-179 non-widening,
# above). codex/gemini remain non-hook-targets.
# ---------------------------------------------------------------------------
@test "FR-181: schema ACCEPTS an antigravity HOOK target" {
  cat > "$PROJ/ok-ag-hook.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "hooks": [
    { "name": "test-gate", "event": "PreToolUse",
      "canonical": { "command": "$HOME/.igris/core/hooks/bridges/antigravity/pre_tool_use.sh", "matcher": "*" },
      "targets": [ { "type": "antigravity", "method": "merge" } ] } ] } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/ok-ag-hook.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "FR-181: schema REJECTS codex as a HOOK target (hook enum stays claude/opencode/antigravity)" {
  cat > "$PROJ/bad-codex-hook.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "hooks": [
    { "name": "test-gate", "event": "PreToolUse",
      "canonical": { "command": "$HOME/x.sh", "matcher": "*" },
      "targets": [ { "type": "codex", "method": "merge" } ] } ] } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad-codex-hook.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"codex"* || "$output" == *"enum"* || "$output" == *"oneOf"* ]]
}

# ---------------------------------------------------------------------------
# FR-277: the `model_tiers` map (AC1). Each case runs on BOTH validation paths
# — the structural fallback (jsonschema blocked) and the default path (the
# python jsonschema path when it is installed) — and the schema file itself is
# checked with ajv's draft 2020-12 validator, which stands in for the
# jsonschema path on machines without the python module. Every failing case
# names its JSON path (`model_tiers/...`), so a rejection for the old reason
# (an unknown top-level key, the 4013c55 behaviour) fails the assertion.
#   S1 a valid map passes          S6 a role with tier `huge`
#   S2 a missing `light` tier      S7 a bad `by_size` key
#   S3 effort `extreme`            S8 an overlay carrying the map (base-only)
#   S4 model `gp"t` (injection)    S9 a claude column with provider openai
#   S5 an extra harness key
# ---------------------------------------------------------------------------

# fr277_manifest <out> [python statement over the map `t`]
fr277_manifest() {
  python3 - "$1" "${2:-pass}" <<'PY'
import json, sys
out, stmt = sys.argv[1], sys.argv[2]
def col(p, m, e): return {"provider": p, "model": m, "effort": e}
t = {"tiers": {
        "deep":   {"claude": col("anthropic", "fable", "high"),    "codex": col("openai", "gpt-6.2-astra", "high")},
        "strong": {"claude": col("anthropic", "opus", "medium"),   "codex": col("openai", "gpt-6.2-astra", "medium")},
        "fast":   {"claude": col("anthropic", "sonnet", "medium"), "codex": col("openai", "gpt-6.2-sol", "medium")},
        "light":  {"claude": col("anthropic", "haiku", "low"),     "codex": col("openai", "gpt-6-luna", "low")}},
     "roles": {"warden": {"tier": "fast"},
               "forger": {"tier": "strong", "by_size": {"L": {"effort": "high"}, "XL": {"tier": "deep", "effort": "high"}}}}}
exec(stmt)
agent = lambda n: {"name": n, "canonical": {"dir": "canon", "file": n + ".md", "versioned": False},
                   "targets": [{"type": "claude", "path": ".claude/agents/" + n + ".md"}]}
json.dump({"version": 1, "model_tiers": t, "agents": [agent("warden"), agent("forger")]},
          open(out, "w", encoding="utf-8"), indent=2)
PY
}

# fr277_paths <manifest> — validate_manifest forced-structural, then default.
fr277_paths() {
  local blockdir="$PROJ/noimport"
  mkdir -p "$blockdir"
  cat > "$blockdir/sitecustomize.py" <<'PY'
import sys
class _Blocker:
    def find_spec(self, name, path=None, target=None):
        if name == "jsonschema" or name.startswith("jsonschema."):
            raise ImportError("jsonschema blocked for test")
        return None
    def find_module(self, name, path=None):
        return self if name == "jsonschema" else None
    def load_module(self, name):
        raise ImportError("jsonschema blocked for test")
sys.meta_path.insert(0, _Blocker())
PY
  echo "--structural"
  PYTHONPATH="$blockdir" bash -c "source '$COMMON' && validate_manifest '$1' '$SCHEMA'" 2>&1; echo "rc=$?"
  echo "--default"
  bash -c "source '$COMMON' && validate_manifest '$1' '$SCHEMA'" 2>&1; echo "rc=$?"
}

# fr277_ajv <manifest> — "VALID", or the first error's instancePath plus the
# missing/extra property name. Skips when ajv is not installed.
fr277_ajv() {
  local ajv="$IGRIS_ROOT/node_modules/ajv/dist/2020.js"
  command -v node >/dev/null 2>&1 && [ -f "$ajv" ] || { echo "NO-AJV"; return 0; }
  node -e '
    const Ajv = require(process.argv[1]).default;
    const fs = require("fs");
    const ajv = new Ajv({ strict: false });
    const ok = ajv.validate(JSON.parse(fs.readFileSync(process.argv[2], "utf8")),
                            JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
    if (ok) { console.log("VALID"); process.exit(0); }
    const e = ajv.errors[0];
    console.log(e.instancePath + " " + (e.params.missingProperty || e.params.additionalProperty || e.keyword));
  ' "$ajv" "$SCHEMA" "$1"
}

# fr277_rejects <manifest> <json-path> [ajv-expect] — both paths fail naming
# the path; ajv reports it too.
fr277_rejects() {
  local out
  out="$(fr277_paths "$1")"
  [ "$(printf '%s\n' "$out" | grep -c '^rc=0$')" -eq 0 ] || { echo "$out"; return 1; }
  [ "$(printf '%s\n' "$out" | grep -cF -- "$2")" -ge 2 ] || { echo "path '$2' not named on both paths:"; echo "$out"; return 1; }
  if [ -n "${3:-}" ]; then
    out="$(fr277_ajv "$1")"
    [ "$out" = NO-AJV ] || [ "$out" = "$3" ] || { echo "ajv: $out (want $3)"; return 1; }
  fi
}

@test "FR-277 S1: a valid model_tiers map passes on both paths and under ajv" {
  fr277_manifest "$PROJ/mt.json"
  run fr277_paths "$PROJ/mt.json"
  [ "$(printf '%s\n' "$output" | grep -c '^rc=0$')" -eq 2 ] || { echo "$output"; return 1; }
  run fr277_ajv "$PROJ/mt.json"
  [ "$output" = VALID ] || [ "$output" = NO-AJV ] || { echo "$output"; return 1; }
}

@test "FR-277 S2: a map missing the light tier fails at model_tiers/tiers" {
  fr277_manifest "$PROJ/mt.json" 'del t["tiers"]["light"]'
  run fr277_rejects "$PROJ/mt.json" "model_tiers/tiers" "/model_tiers/tiers light"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "FR-277 S3: effort 'extreme' fails at model_tiers/tiers/fast/codex/effort" {
  fr277_manifest "$PROJ/mt.json" 't["tiers"]["fast"]["codex"]["effort"] = "extreme"'
  run fr277_rejects "$PROJ/mt.json" "model_tiers/tiers/fast/codex/effort" "/model_tiers/tiers/fast/codex/effort enum"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "FR-277 S4: a model id carrying a quote (TOML/YAML injection) fails at its path" {
  fr277_manifest "$PROJ/mt.json" 't["tiers"]["fast"]["codex"]["model"] = "gp\"t"'
  run fr277_rejects "$PROJ/mt.json" "model_tiers/tiers/fast/codex/model" "/model_tiers/tiers/fast/codex/model pattern"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "FR-277 S5: an extra harness column fails at model_tiers/tiers/fast" {
  fr277_manifest "$PROJ/mt.json" 't["tiers"]["fast"]["gemini"] = dict(t["tiers"]["fast"]["claude"])'
  run fr277_rejects "$PROJ/mt.json" "model_tiers/tiers/fast" "/model_tiers/tiers/fast gemini"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" != *"unknown top-level key"* ]] || { echo "$output"; return 1; }
}

@test "FR-277 S6: a role with tier 'huge' fails at model_tiers/roles/warden/tier" {
  fr277_manifest "$PROJ/mt.json" 't["roles"]["warden"]["tier"] = "huge"'
  run fr277_rejects "$PROJ/mt.json" "model_tiers/roles/warden/tier" "/model_tiers/roles/warden/tier enum"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "FR-277 S7: a bad by_size key fails at model_tiers/roles/forger/by_size" {
  fr277_manifest "$PROJ/mt.json" 't["roles"]["forger"]["by_size"]["XXL"] = {"tier": "deep"}'
  run fr277_rejects "$PROJ/mt.json" "model_tiers/roles/forger/by_size" "/model_tiers/roles/forger/by_size XXL"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "FR-277 S8: an overlay carrying model_tiers is a hard error (the map is base-only)" {
  # A valid map with no roles, so the overlay validates on its own and the
  # refusal is the merge's.
  fr277_manifest "$PROJ/overlay.json" 't["roles"] = {}'
  python3 - "$PROJ/overlay.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
m["agents"] = [{"name": "personal-x", "layer": "personal",
                "canonical": {"dir": "canon", "file": "sample.md", "versioned": False},
                "targets": [{"type": "claude", "path": ".claude/agents/personal-x.md"}]}]
json.dump(m, open(sys.argv[1], "w", encoding="utf-8"))
PY
  run bash -c "source '$COMMON' && merge_overlay_manifest '$PROJ/harness-manifest.json' '$PROJ/overlay.json'"
  [ "$status" -ne 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"model_tiers"*"base-only"* ]] || { echo "$output"; return 1; }
  run bash "$COMPILE" --project-root "$PROJ" --overlay "$PROJ/overlay.json" --surface agents --target claude
  [ "$status" -ne 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"base-only"* ]] || { echo "$output"; return 1; }
}

@test "FR-277 S9: a claude column whose provider is openai fails at its path" {
  fr277_manifest "$PROJ/mt.json" 't["tiers"]["fast"]["claude"]["provider"] = "openai"'
  run fr277_rejects "$PROJ/mt.json" "model_tiers/tiers/fast/claude/provider" "/model_tiers/tiers/fast/claude/provider const"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}
