#!/usr/bin/env bats

# harness_skills.test.bash - Tests for the FR-137 skills surface.
#
# FR-137 folds the FR-103 skill compilers into the FR-136 manifest-driven
# engine so skills become a first-class, drift-checked surfaces.skills
# declaration. These tests cover, against self-contained temp projects:
#
#   1. The schema validates a well-formed surfaces.skills block and REJECTS
#      malformed ones (missing target key, bad type/method enum, unknown
#      surfaces key) - via the STRUCTURAL-FALLBACK path (no jsonschema), which
#      is the live path on most installs. (When jsonschema IS installed the
#      same assertions hold via the schema-validation path.)
#   2. compile projects the skills surface idempotently (byte-identical across
#      two runs - proves the date-marker handling is drift-stable).
#   3. check_harness_drift flags a mutated projected skill artifact (codex
#      AGENTS.md and gemini TOML), and returns to MATCH after recompile.
#   4. A date-only change to the AGENTS.md generated-marker stays MATCH (the
#      strip-before-sha contract: drift is date-stable across days).
#   5. merge_overlay_manifest merges a personal surfaces.skills target
#      additively, and a path collision with a core skill-target is a hard
#      error (the FR-139 overlay seam).
#
# The core surfaces-manifest.json is GLOBAL: it is only unioned when the
# checked project OWNS it (realpath under --project-root). These tests use
# project-OWNED skills surfaces so they are hermetic and never touch the
# machine's ~/.igris/core/skills.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMMON="$ADAPTERS/_common.sh"
  SCHEMA="$ADAPTERS/manifest.schema.json"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"
  SURFACES="$ADAPTERS/surfaces-manifest.json"

  [ -f "$COMMON" ] || skip "_common.sh missing at $COMMON"
  [ -f "$SCHEMA" ] || skip "manifest.schema.json missing at $SCHEMA"
  [ -f "$SURFACES" ] || skip "surfaces-manifest.json missing at $SURFACES"
  require_python3

  PROJ="$TEST_TEMP_DIR/harness_skills_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ/skills/alpha" "$PROJ/skills/beta" "$PROJ/.gemini/commands"

  cat > "$PROJ/skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: the alpha skill
---

# Alpha

Alpha skill body.
EOF

  cat > "$PROJ/skills/beta/SKILL.md" <<'EOF'
---
name: beta
description: the beta skill
---

# Beta

Beta skill body.
EOF

  # A project-OWNED manifest declaring a skills surface against the local
  # skills dir (so the test never touches ~/.igris/core/skills).
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": {
      "source": "skills",
      "layer": "core",
      "targets": [
        { "type": "codex",  "method": "compiler",  "path": "AGENTS.md" },
        { "type": "gemini", "method": "converter", "path": ".gemini/commands" }
      ]
    }
  }
}
EOF
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

# --- Schema validation -------------------------------------------------------

@test "schema validates a well-formed surfaces.skills block (exit 0)" {
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/harness-manifest.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "the shipped surfaces-manifest.json validates against the schema" {
  run bash -c "source '$COMMON' && validate_manifest '$SURFACES' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "schema rejects a skills target missing 'method'" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "codex", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"method"* ]]
}

@test "schema rejects a bad skills target 'method' enum" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "codex", "method": "frobnicate", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"frobnicate"* || "$output" == *"method"* ]]
}

@test "schema rejects a bad skills target 'type' enum" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "claude", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"claude"* || "$output" == *"type"* ]]
}

@test "schema rejects an unknown key under surfaces (additionalProperties:false)" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [], "surfaces": { "skillz": {} } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"skillz"* || "$output" == *"unknown"* ]]
}

@test "schema rejects an empty skills targets array" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [], "surfaces": { "skills": { "targets": [] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"targets"* ]]
}

# The structural-fallback path is exercised by every test above on a machine
# without `jsonschema`. This test makes the no-jsonschema path explicit by
# poisoning the import so it cannot be loaded, proving surfaces validation is
# NOT silently skipped when jsonschema is absent.
@test "structural-fallback path validates surfaces even with jsonschema forced off" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "codex", "path": "AGENTS.md" } ] } } }
EOF
  # A fake module dir with a jsonschema.py that raises on import would still be
  # importable; instead we point PYTHONPATH at a dir whose `jsonschema` is a
  # non-package file that errors. Simplest robust approach: a sitecustomize that
  # blocks the import.
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
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"method"* ]]
}

# --- Compile + idempotency ---------------------------------------------------

@test "compile projects the skills surface (codex AGENTS.md + gemini TOMLs)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills/codex"* ]]
  [[ "$output" == *"skills/gemini"* ]]
  assert_file_exists "$PROJ/AGENTS.md"
  assert_file_exists "$PROJ/.gemini/commands/alpha.toml"
  assert_file_exists "$PROJ/.gemini/commands/beta.toml"
}

@test "skills compile is idempotent (byte-identical AGENTS.md + TOML on re-run)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  cp "$PROJ/AGENTS.md" "$PROJ/AGENTS.first"
  cp "$PROJ/.gemini/commands/alpha.toml" "$PROJ/alpha.first"

  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]

  run diff -q "$PROJ/AGENTS.first" "$PROJ/AGENTS.md"
  [ "$status" -eq 0 ]
  run diff -q "$PROJ/alpha.first" "$PROJ/.gemini/commands/alpha.toml"
  [ "$status" -eq 0 ]
}

@test "--surface skills compiles only the skills surface" {
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills/codex"* ]]
  [[ "$output" == *"skills/gemini"* ]]
}

# --- Drift coverage ----------------------------------------------------------

@test "drift reports MATCH for a freshly compiled skills surface (exit 0)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/codex] MATCH"* ]]
  [[ "$output" == *"[skills/gemini] MATCH"* ]]
}

@test "drift flags a mutated AGENTS.md and recovers after recompile" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  printf '\n# injected\nstray skill content\n' >> "$PROJ/AGENTS.md"

  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/codex] DRIFTED"* ]]

  run bash "$COMPILE" --project-root "$PROJ" --surface skills --target codex
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/codex] MATCH"* ]]
}

@test "drift flags a mutated gemini TOML" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  printf '\nextra = "x"\n' >> "$PROJ/.gemini/commands/beta.toml"

  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/gemini] DRIFTED"* ]]
}

@test "drift is date-stable: a date-only marker change stays MATCH" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  # Rewrite ONLY the date inside the trailing generated-marker line.
  python3 - "$PROJ/AGENTS.md" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p, encoding="utf-8").read()
t = re.sub(r"on \d{4}-\d{2}-\d{2}", "on 2099-12-31", t)
open(p, "w", encoding="utf-8").write(t)
PY
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/codex] MATCH"* ]]
}

@test "drift reports MISSING for a never-compiled skills surface" {
  # No compile -> AGENTS.md and TOMLs absent.
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/codex] MISSING"* ]]
}

# --- Overlay merge seam (FR-139) --------------------------------------------

@test "overlay merges a personal skills target additively" {
  cat > "$PROJ/base.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills",
    "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  cat > "$PROJ/overlay.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "gemini", "method": "converter", "path": ".gemini/commands" } ] } } }
EOF
  run bash -c "source '$COMMON' && merge_overlay_manifest '$PROJ/base.json' '$PROJ/overlay.json'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"AGENTS.md"* ]]
  [[ "$output" == *".gemini/commands"* ]]
}

@test "overlay skill-target path collision with a core skill is a hard error" {
  cat > "$PROJ/base.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  cat > "$PROJ/overlay.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "source '$COMMON' && merge_overlay_manifest '$PROJ/base.json' '$PROJ/overlay.json'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"collides"* || "$output" == *"shadow"* ]]
}
