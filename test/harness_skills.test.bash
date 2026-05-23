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

  # Isolate from the live brain dir so the guard/compile do NOT
  # auto-discover the user's personal overlay manifest at
  # ~/.igris/registry/harness-manifest.personal.json (FR-146 leaves this in
  # place between runs; without isolation it merges into every test's
  # manifest and breaks synthetic-root tests).
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

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

# --- TD-191 multi-source skills surface --------------------------------------
#
# `surfaces.skills` is now an ARRAY of blocks. Each block carries its OWN
# source + targets. Personal blocks compile ALONGSIDE the core block (the
# pre-TD-191 model unioned targets against the BASE source; that's gone).
# These tests prove:
#   1. The schema accepts the new array shape (both schema + structural-fallback).
#   2. An empty array is rejected (minItems:1).
#   3. The legacy single-object shape still normalizes (back-compat).
#   4. The cross-block path-collision merge guard fires across the wider surface.
#   5. The DUAL-SOURCE DUAL-COMPILE load-bearing scenario: TWO sibling blocks
#      with distinct sources project to DISTINCT outputs from their OWN sources
#      (proves the multi-source fix end-to-end via the REAL compiler).
#   6. Drift-parity holds (drift returns MATCH; mutation flips it; recompile
#      restores MATCH — L-519 §18.1 compile/drift-verify pairing).

@test "TD-191 schema accepts an array of skills blocks" {
  cat > "$PROJ/array.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "skills",
      "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS-core.md" } ] },
    { "source": "skills",
      "targets": [ { "type": "gemini", "method": "converter", "path": ".gemini/commands" } ] }
  ] } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/array.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "TD-191 schema rejects an empty array of skills blocks (minItems:1)" {
  cat > "$PROJ/empty-array.json" <<'EOF'
{ "version": 1, "agents": [], "surfaces": { "skills": [] } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/empty-array.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"array"* || "$output" == *"minItems"* ]]
}

@test "TD-191 back-compat: legacy single-object skills normalizes (structural fallback)" {
  # Force the no-jsonschema path so the structural-fallback's array normalizer
  # is the one under test. (The jsonschema path is array-only by schema; the
  # fallback must agree by normalizing a legacy single-object to [object].)
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
  # Legacy single-object surfaces.skills (pre-TD-191) — must still pass via
  # structural-fallback normalize.
  cat > "$PROJ/legacy.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills",
    "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] } } }
EOF
  run bash -c "PYTHONPATH='$blockdir' source '$COMMON' && PYTHONPATH='$blockdir' validate_manifest '$PROJ/legacy.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "TD-191 cross-block path-collision (overlay-vs-base) is a hard error" {
  # Same pattern as the original collision test, but explicitly using the
  # TD-191 array shape on both sides — proves the wider cross-block guard
  # supersedes the legacy base-vs-overlay-only check.
  cat > "$PROJ/base-array.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "skills-core",
      "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] }
  ] } }
EOF
  cat > "$PROJ/overlay-array.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "skills-personal",
      "targets": [ { "type": "codex", "method": "compiler", "path": "AGENTS.md" } ] }
  ] } }
EOF
  run bash -c "source '$COMMON' && merge_overlay_manifest '$PROJ/base-array.json' '$PROJ/overlay-array.json'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"collides"* ]]
}

@test "TD-191 dual-source dual-compile: distinct sources project to distinct outputs" {
  # The LOAD-BEARING scenario this brief exists to enable. Pre-TD-191 the
  # personal source was DROPPED because the merge kept base.source and
  # unioned targets only. Post-TD-191 both blocks compile from their OWN
  # sources, producing two distinct output trees with body-distinct content.
  mkdir -p "$PROJ/skills-core/alpha" "$PROJ/skills-mine/mine"
  cat > "$PROJ/skills-core/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: core alpha
---

ALPHA_CORE_BODY_MARKER
EOF
  cat > "$PROJ/skills-mine/mine/SKILL.md" <<'EOF'
---
name: mine
description: personal mine
---

MINE_PERSONAL_BODY_MARKER
EOF
  # The base manifest carries TWO blocks (a "merged-shape" of what core+overlay
  # would look like post-merge); we drive the compiler directly without an
  # overlay to keep the test hermetic to the bash core (no CLI involvement).
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      { "source": "skills-core",
        "layer": "core",
        "targets": [ { "type": "gemini", "method": "converter", "path": "gemini-core" } ] },
      { "source": "skills-mine",
        "layer": "personal",
        "targets": [ { "type": "gemini", "method": "converter", "path": "gemini-mine" } ] }
    ]
  }
}
EOF
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  assert_file_exists "$PROJ/gemini-core/alpha.toml"
  assert_file_exists "$PROJ/gemini-mine/mine.toml"
  # Cross-source isolation: alpha.toml MUST NOT be in the personal output,
  # and mine.toml MUST NOT be in the core output. Pre-TD-191's collapse
  # would have either produced alpha.toml in both, or only honored block 1.
  [ ! -f "$PROJ/gemini-mine/alpha.toml" ]
  [ ! -f "$PROJ/gemini-core/mine.toml" ]
  # Body distinctness: each output's TOML contains the body of its OWN
  # source skill (not the sibling block's body).
  grep -q "ALPHA_CORE_BODY_MARKER" "$PROJ/gemini-core/alpha.toml"
  grep -q "MINE_PERSONAL_BODY_MARKER" "$PROJ/gemini-mine/mine.toml"
  ! grep -q "MINE_PERSONAL_BODY_MARKER" "$PROJ/gemini-core/alpha.toml"
  ! grep -q "ALPHA_CORE_BODY_MARKER" "$PROJ/gemini-mine/mine.toml"
}

@test "TD-191 drift-parity: dual-source compile + drift MATCH; mutation flips it; recompile restores" {
  # L-519 §18.1 compile + drift-verify pairing. The compile pass and the
  # drift pass must produce IDENTICAL flatten rows so a freshly-compiled
  # dual-source surface returns MATCH for every block/target, and a
  # mutation flips ONLY the affected one.
  mkdir -p "$PROJ/skills-core/alpha" "$PROJ/skills-mine/mine"
  cat > "$PROJ/skills-core/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: a
---
alpha body
EOF
  cat > "$PROJ/skills-mine/mine/SKILL.md" <<'EOF'
---
name: mine
description: m
---
mine body
EOF
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      { "source": "skills-core", "layer": "core",
        "targets": [ { "type": "gemini", "method": "converter", "path": "gemini-core" } ] },
      { "source": "skills-mine", "layer": "personal",
        "targets": [ { "type": "gemini", "method": "converter", "path": "gemini-mine" } ] }
    ]
  }
}
EOF
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  # Mutate the personal block's output to flip drift on it.
  printf '\nextra = "x"\n' >> "$PROJ/gemini-mine/mine.toml"
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"DRIFTED"* ]]
  # Recompile → both blocks back to MATCH.
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# FR-149: claude as a first-class skills target (claude/symlink).
#
# Compile-side behavior: registry-anchored per-skill symlinks under the
# target dir (one per <skill>/SKILL.md in `source`). Idempotent on rerun
# (silent no-op), atomic-repoint on path mismatch with a log line, and
# refuse-to-clobber a non-symlink at the target path. L-519 §18.1 pairs
# this with the drift-verify branch (covered in harness_drift_gate.test.bash).
# ---------------------------------------------------------------------------

# build_fr149_skill_project: helper to seed a per-test project with ONE
# personal skills block declaring a claude:symlink target. The "source"
# (skills root) lives at PROJ/registry-skills/<name>/ to simulate the
# L-516 registry-vendored layout; the compiler emits the symlink under
# PROJ/.claude/skills/<name>.
build_fr149_skill_project() {
  mkdir -p "$PROJ/registry-skills/alpha"
  cat > "$PROJ/registry-skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: alpha skill for FR-149 claude/symlink
---

alpha body
EOF
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "registry-skills",
        "layer": "personal",
        "targets": [
          { "type": "claude", "method": "symlink", "path": ".claude/skills" }
        ]
      }
    ]
  }
}
EOF
}

@test "FR-149: cold compile creates a claude/symlink per skill at the right target" {
  build_fr149_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # The symlink lives at PROJ/.claude/skills/alpha → PROJ/registry-skills/alpha.
  [ -L "$PROJ/.claude/skills/alpha" ]
  local resolved
  resolved="$(readlink "$PROJ/.claude/skills/alpha")"
  [ "$resolved" = "$PROJ/registry-skills/alpha" ]
  [[ "$output" == *"creating claude skill symlink"* ]]
  [[ "$output" == *"OK    skills/claude (symlink)"* ]]
}

@test "FR-149: legacy symlink gets atomically repointed (migration log line)" {
  build_fr149_skill_project
  # Pre-create a symlink pointing somewhere ELSE (simulating legacy state).
  mkdir -p "$PROJ/.claude/skills" "$PROJ/elsewhere/alpha"
  ln -s "$PROJ/elsewhere/alpha" "$PROJ/.claude/skills/alpha"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  local resolved
  resolved="$(readlink "$PROJ/.claude/skills/alpha")"
  [ "$resolved" = "$PROJ/registry-skills/alpha" ]
  # Migration log line, NOT a create log line.
  [[ "$output" == *"migrating legacy claude skill symlink"* ]]
  [[ "$output" != *"creating claude skill symlink"* ]]
}

@test "FR-149: refuse-to-clobber a regular file at the symlink path" {
  build_fr149_skill_project
  # Pre-create a REGULAR FILE at the symlink target.
  mkdir -p "$PROJ/.claude/skills"
  echo "operator-authored content" > "$PROJ/.claude/skills/alpha"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -ne 0 ]
  # File is unchanged (refuse-to-clobber guarantee).
  local content
  content="$(cat "$PROJ/.claude/skills/alpha")"
  [ "$content" = "operator-authored content" ]
  # Still a regular file, NOT a symlink.
  [ ! -L "$PROJ/.claude/skills/alpha" ]
  [[ "$output" == *"refuse to clobber"* ]]
  [[ "$output" == *"FAIL  skills/claude/alpha"* ]]
}

@test "FR-149: claude/symlink compile is idempotent (silent no-op on rerun)" {
  build_fr149_skill_project
  # First compile creates the symlink.
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [[ "$output" == *"creating claude skill symlink"* ]]
  # Capture the inode so we can prove no churn.
  local inode_before
  inode_before="$(stat -f '%i' "$PROJ/.claude/skills/alpha" 2>/dev/null \
                 || stat -c '%i' "$PROJ/.claude/skills/alpha")"
  # Second compile: no create log, no migrate log, symlink unchanged.
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [[ "$output" != *"creating claude skill symlink"* ]]
  [[ "$output" != *"migrating legacy claude skill symlink"* ]]
  local inode_after
  inode_after="$(stat -f '%i' "$PROJ/.claude/skills/alpha" 2>/dev/null \
                || stat -c '%i' "$PROJ/.claude/skills/alpha")"
  [ "$inode_before" = "$inode_after" ]
}
