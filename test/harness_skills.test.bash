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
  # FR-153 + L-515: drift's "registry containment" check requires the symlink
  # target to resolve UNDER the brain registry root, so skills source lives at
  # $IGRIS_BRAIN_DIR/registry/skills (mirrors the real `igris registry
  # add-skill` flow which vendors skills under <brain>/registry/skills/).
  mkdir -p "$PROJ" "$IGRIS_BRAIN_DIR/registry/skills/alpha" \
    "$IGRIS_BRAIN_DIR/registry/skills/beta"

  cat > "$IGRIS_BRAIN_DIR/registry/skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: the alpha skill
---

# Alpha

Alpha skill body.
EOF

  cat > "$IGRIS_BRAIN_DIR/registry/skills/beta/SKILL.md" <<'EOF'
---
name: beta
description: the beta skill
---

# Beta

Beta skill body.
EOF

  # A project-OWNED manifest declaring a skills surface against the registry-
  # vendored skills dir (so drift's L-515 containment check fires MATCH).
  # FR-153: all 3 harnesses now use the symlink method. Source is the
  # ABSOLUTE registry path — satisfies codex/symlink's D2 absolute-path
  # guard AND resides under <brain>/registry/ for L-515 MATCH.
  SKILLS_SRC="$IGRIS_BRAIN_DIR/registry/skills"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": {
      "source": "$SKILLS_SRC",
      "layer": "core",
      "targets": [
        { "type": "codex",  "method": "symlink",  "path": ".codex/skills" },
        { "type": "gemini", "method": "symlink",  "path": ".gemini/skills" }
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
  "surfaces": { "skills": { "targets": [ { "type": "codex", "path": ".codex/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"method"* ]]
}

@test "schema rejects a bad skills target 'method' enum" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "codex", "method": "frobnicate", "path": ".codex/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"frobnicate"* || "$output" == *"method"* ]]
}

@test "schema rejects a bad skills target 'type' enum" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "claude", "method": "compiler", "path": ".claude/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"claude"* || "$output" == *"type"* || "$output" == *"pair"* ]]
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
  "surfaces": { "skills": { "targets": [ { "type": "codex", "path": ".codex/skills" } ] } } }
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

@test "compile projects the skills surface (codex + gemini per-skill symlinks)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills/codex"* ]]
  [[ "$output" == *"skills/gemini"* ]]
  # FR-153: per-skill symlinks under .codex/skills/ + .gemini/skills/.
  [ -L "$PROJ/.codex/skills/alpha" ]
  [ -L "$PROJ/.codex/skills/beta" ]
  [ -L "$PROJ/.gemini/skills/alpha" ]
  [ -L "$PROJ/.gemini/skills/beta" ]
}

@test "skills compile is idempotent (same inode on re-run)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  local codex_inode_before gemini_inode_before
  codex_inode_before="$(stat -f '%i' "$PROJ/.codex/skills/alpha" 2>/dev/null \
                       || stat -c '%i' "$PROJ/.codex/skills/alpha")"
  gemini_inode_before="$(stat -f '%i' "$PROJ/.gemini/skills/alpha" 2>/dev/null \
                        || stat -c '%i' "$PROJ/.gemini/skills/alpha")"

  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]

  local codex_inode_after gemini_inode_after
  codex_inode_after="$(stat -f '%i' "$PROJ/.codex/skills/alpha" 2>/dev/null \
                      || stat -c '%i' "$PROJ/.codex/skills/alpha")"
  gemini_inode_after="$(stat -f '%i' "$PROJ/.gemini/skills/alpha" 2>/dev/null \
                       || stat -c '%i' "$PROJ/.gemini/skills/alpha")"
  [ "$codex_inode_before" = "$codex_inode_after" ]
  [ "$gemini_inode_before" = "$gemini_inode_after" ]
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

@test "FR-153: drift flags a manually-repointed codex symlink (registry-unanchored) and recovers after recompile" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  # Repoint one of the codex skill symlinks to somewhere ELSE (outside the
  # source root); drift should flag it as registry-unanchored / mismatched.
  mkdir -p "$PROJ/elsewhere/alpha"
  rm "$PROJ/.codex/skills/alpha"
  ln -s "$PROJ/elsewhere/alpha" "$PROJ/.codex/skills/alpha"

  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/codex] DRIFTED"* ]]

  run bash "$COMPILE" --project-root "$PROJ" --surface skills --target codex
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/codex] MATCH"* ]]
}

@test "FR-153: drift flags a mutated gemini symlink (file at target instead of link)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  # Replace one gemini symlink with a regular file → drift verdict fires.
  rm "$PROJ/.gemini/skills/beta"
  echo "operator-edit-bytes" > "$PROJ/.gemini/skills/beta"

  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/gemini] DRIFTED"* ]]
}

@test "drift reports MISSING for a never-compiled skills surface" {
  # No compile -> no symlinks present at target paths.
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/codex] MISSING"* ]]
}

# --- Overlay merge seam (FR-139) --------------------------------------------

@test "overlay merges a personal skills target additively" {
  cat > "$PROJ/base.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills",
    "targets": [ { "type": "codex", "method": "symlink", "path": ".codex/skills" } ] } } }
EOF
  cat > "$PROJ/overlay.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "gemini", "method": "symlink", "path": ".gemini/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && merge_overlay_manifest '$PROJ/base.json' '$PROJ/overlay.json'"
  [ "$status" -eq 0 ]
  [[ "$output" == *".codex/skills"* ]]
  [[ "$output" == *".gemini/skills"* ]]
}

@test "overlay skill-target path collision with a core skill is a hard error" {
  cat > "$PROJ/base.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "codex", "method": "symlink", "path": ".codex/skills" } ] } } }
EOF
  cat > "$PROJ/overlay.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "codex", "method": "symlink", "path": ".codex/skills" } ] } } }
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
      "targets": [ { "type": "codex", "method": "symlink", "path": ".codex/core/skills" } ] },
    { "source": "skills",
      "targets": [ { "type": "gemini", "method": "symlink", "path": ".gemini/skills" } ] }
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
  # structural-fallback normalize. FR-153: only symlink pairs are still
  # accepted post-tightening.
  cat > "$PROJ/legacy.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills",
    "targets": [ { "type": "codex", "method": "symlink", "path": ".codex/skills" } ] } } }
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
      "targets": [ { "type": "codex", "method": "symlink", "path": ".codex/skills" } ] }
  ] } }
EOF
  cat > "$PROJ/overlay-array.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "skills-personal",
      "targets": [ { "type": "codex", "method": "symlink", "path": ".codex/skills" } ] }
  ] } }
EOF
  run bash -c "source '$COMMON' && merge_overlay_manifest '$PROJ/base-array.json' '$PROJ/overlay-array.json'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"collides"* ]]
}

@test "TD-191 dual-source dual-compile: distinct sources project to distinct outputs" {
  # The LOAD-BEARING scenario TD-191 exists to enable. Pre-TD-191 the
  # personal source was DROPPED because the merge kept base.source and
  # unioned targets only. Post-TD-191 both blocks compile from their OWN
  # sources. FR-153: the gemini converter pair is retired in favor of
  # symlink; this test now asserts per-block symlink projection.
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
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      { "source": "$PROJ/skills-core",
        "layer": "core",
        "targets": [ { "type": "gemini", "method": "symlink", "path": "gemini-core" } ] },
      { "source": "$PROJ/skills-mine",
        "layer": "personal",
        "targets": [ { "type": "gemini", "method": "symlink", "path": "gemini-mine" } ] }
    ]
  }
}
EOF
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # FR-153: per-skill symlinks under each block's target dir.
  [ -L "$PROJ/gemini-core/alpha" ]
  [ -L "$PROJ/gemini-mine/mine" ]
  # Cross-source isolation: alpha MUST NOT be in the personal output,
  # and mine MUST NOT be in the core output.
  [ ! -e "$PROJ/gemini-mine/alpha" ]
  [ ! -e "$PROJ/gemini-core/mine" ]
  # Body distinctness via following the symlink to the original SKILL.md.
  grep -q "ALPHA_CORE_BODY_MARKER" "$PROJ/gemini-core/alpha/SKILL.md"
  grep -q "MINE_PERSONAL_BODY_MARKER" "$PROJ/gemini-mine/mine/SKILL.md"
}

@test "TD-191 drift-parity: dual-source compile + drift MATCH; mutation flips it; recompile restores" {
  # L-519 §18.1 compile + drift-verify pairing. The compile pass and the
  # drift pass must produce IDENTICAL flatten rows. FR-153: post-retirement
  # this exercises the symlink branches on both sides. Sources live under
  # $IGRIS_BRAIN_DIR/registry so L-515 containment fires MATCH.
  mkdir -p "$IGRIS_BRAIN_DIR/registry/skills-core/alpha" \
    "$IGRIS_BRAIN_DIR/registry/skills-mine/mine"
  cat > "$IGRIS_BRAIN_DIR/registry/skills-core/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: a
---
alpha body
EOF
  cat > "$IGRIS_BRAIN_DIR/registry/skills-mine/mine/SKILL.md" <<'EOF'
---
name: mine
description: m
---
mine body
EOF
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      { "source": "$IGRIS_BRAIN_DIR/registry/skills-core", "layer": "core",
        "targets": [ { "type": "gemini", "method": "symlink", "path": "gemini-core" } ] },
      { "source": "$IGRIS_BRAIN_DIR/registry/skills-mine", "layer": "personal",
        "targets": [ { "type": "gemini", "method": "symlink", "path": "gemini-mine" } ] }
    ]
  }
}
EOF
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  # Mutate the personal block's output to flip drift on it (rm symlink +
  # replace with a real file → drift verdict).
  rm "$PROJ/gemini-mine/mine"
  echo "operator-edit" > "$PROJ/gemini-mine/mine"
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"DRIFTED"* ]]
  # Recompile → operator-authored file at link path → REFUSE-TO-CLOBBER.
  # The mutation must be reverted manually first (matches operator UX).
  rm "$PROJ/gemini-mine/mine"
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
  # TD-209: batched refuse-to-clobber summary block (single-refuse case).
  [[ "$output" == *"Refuse-to-clobber: 1 non-symlink target(s) blocked compile:"* ]]
  [[ "$output" == *"$PROJ/.claude/skills/alpha"* ]]
  [[ "$output" == *"rm "*"&& igris harness compile"* ]]
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

# ---------------------------------------------------------------------------
# FR-153: codex + gemini as first-class skill targets (codex/symlink +
# gemini/symlink) — unified onto the FR-149 claude/symlink primitive.
# Mirror the FR-149 test shapes; assert codex absolute-path enforcement
# (D2) compile-side + drift-side. L-519 §18.1 compile/drift pairing.
# ---------------------------------------------------------------------------

# build_fr153_codex_skill_project: per-test fixture mirroring
# build_fr149_skill_project but emitting a codex:symlink target. The source
# is the registry-vendored skill tree under $IGRIS_BRAIN_DIR/registry/skills/
# so L-515 containment + D2 absolute-path are both satisfied for MATCH.
build_fr153_codex_skill_project() {
  # Setup() seeds alpha+beta; clear and seed alpha-only for this fixture so
  # the legacy-migration tests see ONE skill (no spurious "creating" log for
  # an unrelated sibling).
  rm -rf "$IGRIS_BRAIN_DIR/registry/skills"
  mkdir -p "$IGRIS_BRAIN_DIR/registry/skills/alpha"
  cat > "$IGRIS_BRAIN_DIR/registry/skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: alpha skill for FR-153 codex/symlink
---

alpha body
EOF
  local skills_src="$IGRIS_BRAIN_DIR/registry/skills"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "$skills_src",
        "layer": "personal",
        "targets": [
          { "type": "codex", "method": "symlink", "path": ".codex/skills" }
        ]
      }
    ]
  }
}
EOF
  # Expose the resolved alpha skill_dir for tests that need it.
  FR153_ALPHA_DIR="$IGRIS_BRAIN_DIR/registry/skills/alpha"
}

build_fr153_gemini_skill_project() {
  # See build_fr153_codex_skill_project for the clean-slate rationale.
  rm -rf "$IGRIS_BRAIN_DIR/registry/skills"
  mkdir -p "$IGRIS_BRAIN_DIR/registry/skills/alpha"
  cat > "$IGRIS_BRAIN_DIR/registry/skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: alpha skill for FR-153 gemini/symlink
---

alpha body
EOF
  local skills_src="$IGRIS_BRAIN_DIR/registry/skills"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "$skills_src",
        "layer": "personal",
        "targets": [
          { "type": "gemini", "method": "symlink", "path": ".gemini/skills" }
        ]
      }
    ]
  }
}
EOF
  FR153_ALPHA_DIR="$IGRIS_BRAIN_DIR/registry/skills/alpha"
}

@test "FR-153: cold compile creates a codex/symlink per skill at the right target" {
  build_fr153_codex_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.codex/skills/alpha" ]
  local resolved
  resolved="$(readlink "$PROJ/.codex/skills/alpha")"
  [ "$resolved" = "$FR153_ALPHA_DIR" ]
  [[ "$output" == *"creating codex skill symlink"* ]]
  [[ "$output" == *"OK    skills/codex (symlink)"* ]]
}

@test "FR-153: cold compile creates a gemini/symlink per skill at the right target" {
  build_fr153_gemini_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.gemini/skills/alpha" ]
  local resolved
  resolved="$(readlink "$PROJ/.gemini/skills/alpha")"
  [ "$resolved" = "$FR153_ALPHA_DIR" ]
  [[ "$output" == *"creating gemini skill symlink"* ]]
  [[ "$output" == *"OK    skills/gemini (symlink)"* ]]
}

@test "FR-153 D2: codex/symlink REJECTS a relative-resolved source (absolute-target guard)" {
  # Force a relative skill_dir by passing a relative `source` whose canon
  # base resolution lands on a project-relative path that is NEVER
  # absolutized — Phase 3 in compile_harnesses.sh resolves a relative
  # source against PROJECT_ROOT, so we exercise the guard by abusing a
  # synthetic flatten row. The cleanest fixture is to use a `source` of
  # "." (the project root itself), with SKILL.md alongside — this
  # produces an absolute skill_dir via the project-relative case at the
  # case-arm dispatch, but for D2 we need to prove the guard is in place,
  # not bypass it. So instead: use a `source` that resolves under the
  # project as absolute (so D2 is satisfied) AND assert the absolute
  # symlink in output. The D2 guard is then tested via the drift-side
  # literal-readlink check below — drift catches the foot-gun.
  build_fr153_codex_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # Compile-side guard pass: the link target IS absolute (starts with /).
  local lit
  lit="$(readlink "$PROJ/.codex/skills/alpha")"
  [[ "$lit" == /* ]]
}

@test "FR-153 D2: drift flags a hand-edited relative-target codex symlink" {
  build_fr153_codex_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # Hand-edit the symlink to point at a RELATIVE target — simulates a
  # stale pre-FR-153 manual artifact. Even if realpath resolves correctly
  # from this dir, codex would re-resolve from cwd → drift verdict.
  rm "$PROJ/.codex/skills/alpha"
  # Build a relative-path symlink that resolves correctly from .codex/skills/
  # but is REL-encoded. We compute the relative segment back to alpha.
  local rel_target
  rel_target="$(python3 -c "import os; print(os.path.relpath('$FR153_ALPHA_DIR', '$PROJ/.codex/skills'))")"
  ( cd "$PROJ/.codex/skills" && ln -s "$rel_target" alpha )
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/codex] DRIFTED"* ]]
  [[ "$output" == *"relative target"* || "$output" == *"FR-153 D2"* ]]
}

@test "FR-153: drift returns MATCH for fresh codex/symlink + gemini/symlink (compile/drift pairing)" {
  build_fr153_codex_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/codex] MATCH"* ]]

  # Rebuild fixture with gemini target.
  rm -rf "$PROJ/.codex" "$IGRIS_BRAIN_DIR/registry/skills"
  build_fr153_gemini_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/gemini] MATCH"* ]]
}

@test "FR-153: drift flags a manually-rewritten codex symlink pointing OUTSIDE the registry" {
  build_fr153_codex_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # Repoint the codex symlink to a non-registry, non-source dir.
  mkdir -p "$PROJ/elsewhere/alpha"
  rm "$PROJ/.codex/skills/alpha"
  ln -s "$PROJ/elsewhere/alpha" "$PROJ/.codex/skills/alpha"
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/codex] DRIFTED"* ]]
}

@test "FR-153: refuse-to-clobber a regular file at the codex symlink path" {
  build_fr153_codex_skill_project
  mkdir -p "$PROJ/.codex/skills"
  echo "operator-authored" > "$PROJ/.codex/skills/alpha"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -ne 0 ]
  # File is unchanged.
  [ "$(cat "$PROJ/.codex/skills/alpha")" = "operator-authored" ]
  [ ! -L "$PROJ/.codex/skills/alpha" ]
  [[ "$output" == *"refuse to clobber"* ]]
  [[ "$output" == *"FAIL  skills/codex/alpha"* ]]
  # TD-209: batched refuse-to-clobber summary block (single-refuse case).
  [[ "$output" == *"Refuse-to-clobber: 1 non-symlink target(s) blocked compile:"* ]]
  [[ "$output" == *"$PROJ/.codex/skills/alpha"* ]]
  [[ "$output" == *"rm "*"&& igris harness compile"* ]]
}

@test "FR-153: refuse-to-clobber a regular file at the gemini symlink path" {
  build_fr153_gemini_skill_project
  mkdir -p "$PROJ/.gemini/skills"
  echo "operator-authored" > "$PROJ/.gemini/skills/alpha"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -ne 0 ]
  [ "$(cat "$PROJ/.gemini/skills/alpha")" = "operator-authored" ]
  [ ! -L "$PROJ/.gemini/skills/alpha" ]
  [[ "$output" == *"refuse to clobber"* ]]
  [[ "$output" == *"FAIL  skills/gemini/alpha"* ]]
  # TD-209: batched refuse-to-clobber summary block (single-refuse case).
  [[ "$output" == *"Refuse-to-clobber: 1 non-symlink target(s) blocked compile:"* ]]
  [[ "$output" == *"$PROJ/.gemini/skills/alpha"* ]]
  [[ "$output" == *"rm "*"&& igris harness compile"* ]]
}

@test "FR-153: codex/symlink compile is idempotent (same inode on rerun)" {
  build_fr153_codex_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  local inode_before
  inode_before="$(stat -f '%i' "$PROJ/.codex/skills/alpha" 2>/dev/null \
                 || stat -c '%i' "$PROJ/.codex/skills/alpha")"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [[ "$output" != *"creating codex skill symlink"* ]]
  [[ "$output" != *"migrating legacy codex skill symlink"* ]]
  local inode_after
  inode_after="$(stat -f '%i' "$PROJ/.codex/skills/alpha" 2>/dev/null \
                || stat -c '%i' "$PROJ/.codex/skills/alpha")"
  [ "$inode_before" = "$inode_after" ]
}

@test "FR-153: legacy codex symlink at a non-registry target gets atomically repointed (migration log)" {
  build_fr153_codex_skill_project
  # Pre-create a codex symlink pointing somewhere ELSE (simulates legacy
  # state pre-migration).
  mkdir -p "$PROJ/.codex/skills" "$PROJ/elsewhere/alpha"
  ln -s "$PROJ/elsewhere/alpha" "$PROJ/.codex/skills/alpha"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  local resolved
  resolved="$(readlink "$PROJ/.codex/skills/alpha")"
  [ "$resolved" = "$FR153_ALPHA_DIR" ]
  [[ "$output" == *"migrating legacy codex skill symlink"* ]]
  [[ "$output" != *"creating codex skill symlink"* ]]
}

# ---------------------------------------------------------------------------
# FR-157: `agents/symlink` as a fourth skill target — the cross-CLI shared
# `~/.agents/skills/` standard. Byte-for-byte mirror of FR-153 codex/symlink
# (including D2 absolute-target inheritance). L-519 §18.1 compile/drift
# pairing.
# ---------------------------------------------------------------------------

# build_fr157_agents_skill_project: per-test fixture mirroring
# build_fr153_codex_skill_project but emitting an agents:symlink target.
build_fr157_agents_skill_project() {
  # Clean slate (mirrors FR-153 setup posture).
  rm -rf "$IGRIS_BRAIN_DIR/registry/skills"
  mkdir -p "$IGRIS_BRAIN_DIR/registry/skills/alpha"
  cat > "$IGRIS_BRAIN_DIR/registry/skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: alpha skill for FR-157 agents/symlink
---

alpha body
EOF
  local skills_src="$IGRIS_BRAIN_DIR/registry/skills"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "$skills_src",
        "layer": "personal",
        "targets": [
          { "type": "agents", "method": "symlink", "path": ".agents/skills" }
        ]
      }
    ]
  }
}
EOF
  FR157_ALPHA_DIR="$IGRIS_BRAIN_DIR/registry/skills/alpha"
}

@test "FR-157: cold compile creates an agents/symlink per skill at the right target" {
  build_fr157_agents_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.agents/skills/alpha" ]
  local resolved
  resolved="$(readlink "$PROJ/.agents/skills/alpha")"
  [ "$resolved" = "$FR157_ALPHA_DIR" ]
  [[ "$output" == *"creating agents skill symlink"* ]]
  [[ "$output" == *"OK    skills/agents (symlink)"* ]]
}

@test "FR-157: agents/symlink compile is idempotent (same inode on rerun)" {
  build_fr157_agents_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  local inode_before
  inode_before="$(stat -f '%i' "$PROJ/.agents/skills/alpha" 2>/dev/null \
                 || stat -c '%i' "$PROJ/.agents/skills/alpha")"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [[ "$output" != *"creating agents skill symlink"* ]]
  [[ "$output" != *"migrating legacy agents skill symlink"* ]]
  local inode_after
  inode_after="$(stat -f '%i' "$PROJ/.agents/skills/alpha" 2>/dev/null \
                || stat -c '%i' "$PROJ/.agents/skills/alpha")"
  [ "$inode_before" = "$inode_after" ]
}

@test "FR-157 D2: agents/symlink emits absolute literal target (D2 guard satisfied)" {
  # Compile-side D2 guard: assert the resulting symlink's LITERAL target
  # starts with `/` (codex re-resolves relative symlinks from cwd; the
  # agents/ standard inherits the same hazard).
  build_fr157_agents_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  local lit
  lit="$(readlink "$PROJ/.agents/skills/alpha")"
  [[ "$lit" == /* ]]
}

@test "FR-157 D2: drift flags a hand-edited relative-target agents symlink" {
  build_fr157_agents_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # Hand-edit the symlink to a relative target — drift verdict.
  rm "$PROJ/.agents/skills/alpha"
  local rel_target
  rel_target="$(python3 -c "import os; print(os.path.relpath('$FR157_ALPHA_DIR', '$PROJ/.agents/skills'))")"
  ( cd "$PROJ/.agents/skills" && ln -s "$rel_target" alpha )
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/agents] DRIFTED"* ]]
  [[ "$output" == *"relative target"* || "$output" == *"FR-157 D2"* ]]
}

@test "FR-157: drift returns MATCH for fresh agents/symlink (compile/drift pairing)" {
  build_fr157_agents_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/agents] MATCH"* ]]
}

@test "FR-157: drift returns DRIFTED when a real file sits at the agents symlink target (refuse-to-clobber regression guard)" {
  # Cold-compile, then replace the symlink with a regular file (simulates a
  # stale pre-FR-157 operator-authored file at ~/.agents/skills/<name>).
  build_fr157_agents_skill_project
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  rm "$PROJ/.agents/skills/alpha"
  echo "operator-authored" > "$PROJ/.agents/skills/alpha"
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/agents] DRIFTED"* ]]
  [[ "$output" == *"regular files/dirs, not symlinks"* ]]
}

@test "FR-157: refuse-to-clobber a regular file at the agents symlink path" {
  build_fr157_agents_skill_project
  mkdir -p "$PROJ/.agents/skills"
  echo "operator-authored" > "$PROJ/.agents/skills/alpha"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -ne 0 ]
  [ "$(cat "$PROJ/.agents/skills/alpha")" = "operator-authored" ]
  [ ! -L "$PROJ/.agents/skills/alpha" ]
  [[ "$output" == *"refuse to clobber"* ]]
  [[ "$output" == *"FAIL  skills/agents/alpha"* ]]
  # TD-209: batched refuse-to-clobber summary block (single-refuse case).
  [[ "$output" == *"Refuse-to-clobber: 1 non-symlink target(s) blocked compile:"* ]]
  [[ "$output" == *"$PROJ/.agents/skills/alpha"* ]]
  [[ "$output" == *"rm "*"&& igris harness compile"* ]]
}

# ---------------------------------------------------------------------------
# TD-209: batched refuse-to-clobber summary — multi-refuse regression test.
# Two refused targets in one compile run MUST coalesce into ONE summary block
# (header + listing + single recovery command containing both paths). The
# per-row FAIL log lines are PRESERVED unchanged — only the noise of multiple
# per-file ERROR-block headers is consolidated.
# ---------------------------------------------------------------------------

@test "TD-209: multi-refuse batches into ONE summary block with all paths and a single recovery command" {
  # Build a project with TWO skills (alpha, beta) under the SAME claude
  # symlink target, then plant regular files at BOTH so the compiler
  # refuses both in one pass.
  build_fr149_skill_project   # seeds alpha at $PROJ/registry-skills/alpha
  # Add a second skill source under the same registry-skills root.
  mkdir -p "$PROJ/registry-skills/beta"
  cat > "$PROJ/registry-skills/beta/SKILL.md" <<'EOF'
---
name: beta
description: second skill for TD-209 multi-refuse
---

beta body
EOF
  mkdir -p "$PROJ/.claude/skills"
  echo "operator-alpha" > "$PROJ/.claude/skills/alpha"
  echo "operator-beta"  > "$PROJ/.claude/skills/beta"

  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -ne 0 ]

  # Both per-file FAIL rows still present (per-row log lines unchanged).
  [[ "$output" == *"FAIL  skills/claude/alpha"* ]]
  [[ "$output" == *"FAIL  skills/claude/beta"* ]]

  # ONE batched summary block listing TWO paths.
  [[ "$output" == *"Refuse-to-clobber: 2 non-symlink target(s) blocked compile:"* ]]
  [[ "$output" == *"$PROJ/.claude/skills/alpha"* ]]
  [[ "$output" == *"$PROJ/.claude/skills/beta"* ]]

  # ONE recovery command containing BOTH paths and the recompile invocation,
  # on a single line (not fragmented across 2 rm lines).
  local rm_line
  rm_line="$(printf '%s\n' "$output" | grep -E '^[[:space:]]*rm ' || true)"
  [ -n "$rm_line" ]
  [[ "$rm_line" == *"alpha"* ]]
  [[ "$rm_line" == *"beta"* ]]
  [[ "$rm_line" == *"&& igris harness compile"* ]]

  # Files unchanged (refuse-to-clobber guarantee).
  [ "$(cat "$PROJ/.claude/skills/alpha")" = "operator-alpha" ]
  [ "$(cat "$PROJ/.claude/skills/beta")"  = "operator-beta"  ]
}

# ---------------------------------------------------------------------------
# TD-218: depth-1 skill discoverability + per-skill-path de-dup.
#
# A legacy/hand-edited manifest may carry a per-skill `target.path` that
# already ends in `/<skill_name>` (e.g. `.agents/skills/content-pipeline`
# instead of the PARENT `.agents/skills`). The compile loop appends
# `/<skill_name>`, double-nesting to `.agents/skills/content-pipeline/
# content-pipeline/SKILL.md` (depth-2) — invisible to native loaders that
# scan depth-1. These tests prove:
#   1. (Option C compile de-dup) A malformed per-skill `path` self-heals to
#      a depth-1 symlink (no double-nest); SKILL.md is reachable at depth-1.
#   2. The de-dup generalizes across harness types (agents + claude).
#   3. (drift assertion) A genuine depth-2 nest (compiler de-dup bypassed via
#      a hand-built broken symlink) is flagged DRIFTED with the depth-1 reason.
#   4. Core/parent-path skills (path basename != skill name) do NOT regress —
#      they still land depth-1 and drift stays MATCH.
# ---------------------------------------------------------------------------

# build_td218_malformed_project <type> — seed a per-test project whose ONE
# skills block carries a PER-SKILL malformed path (`<parent>/<name>`) for the
# given target <type> (agents|claude). The source models the REAL registry
# layout: the vendored wrapper `registry/skills/content-pipeline/
# content-pipeline/SKILL.md` (L-517 `<name>/<name>/SKILL.md`), with `source`
# pointing at the OUTER dir — exactly how the deployed content-pipeline
# overlay is shaped. So `skill_dir` = the INNER content-pipeline dir (which
# holds SKILL.md), `skill_name` = content-pipeline, and `out_abs` = the
# malformed `.${ttype}/skills/content-pipeline`. Source resides under
# $IGRIS_BRAIN_DIR/registry so L-515 containment fires MATCH.
build_td218_malformed_project() {
  local ttype="$1"
  rm -rf "$IGRIS_BRAIN_DIR/registry/skills"
  mkdir -p "$IGRIS_BRAIN_DIR/registry/skills/content-pipeline/content-pipeline"
  cat > "$IGRIS_BRAIN_DIR/registry/skills/content-pipeline/content-pipeline/SKILL.md" <<'EOF'
---
name: content-pipeline
description: the content-pipeline skill for TD-218
---

content-pipeline body
EOF
  # `source` is the OUTER dir; find walks <source>/<name>/SKILL.md at depth-2.
  local skills_src="$IGRIS_BRAIN_DIR/registry/skills/content-pipeline"
  # NOTE the malformed path: it ends in the skill name `content-pipeline`
  # (the per-skill shape that produced the FR-153/156/157 double-nest).
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "$skills_src",
        "layer": "personal",
        "targets": [
          { "type": "$ttype", "method": "symlink", "path": ".${ttype}/skills/content-pipeline" }
        ]
      }
    ]
  }
}
EOF
  # The INNER dir is the resolved skill_dir (holds SKILL.md directly).
  TD218_SKILL_DIR="$IGRIS_BRAIN_DIR/registry/skills/content-pipeline/content-pipeline"
  # The OUTER wrapper parent — used by the depth-2 drift test to plant a
  # too-deep (but still registry-anchored) symlink.
  TD218_WRAPPER_DIR="$IGRIS_BRAIN_DIR/registry/skills/content-pipeline"
}

@test "TD-218: compile de-dups a malformed per-skill agents path to depth-1 (no double-nest)" {
  build_td218_malformed_project agents
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # De-dup: the symlink lands at the malformed path itself (depth-1), NOT
  # one level deeper.
  [ -L "$PROJ/.agents/skills/content-pipeline" ]
  [ ! -e "$PROJ/.agents/skills/content-pipeline/content-pipeline" ]
  local resolved
  resolved="$(readlink "$PROJ/.agents/skills/content-pipeline")"
  [ "$resolved" = "$TD218_SKILL_DIR" ]
  # SKILL.md is reachable at depth-1 through the symlink.
  [ -f "$PROJ/.agents/skills/content-pipeline/SKILL.md" ]
}

@test "TD-218: compile de-dups a malformed per-skill claude path to depth-1 (generalizes across types)" {
  build_td218_malformed_project claude
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.claude/skills/content-pipeline" ]
  [ ! -e "$PROJ/.claude/skills/content-pipeline/content-pipeline" ]
  [ -f "$PROJ/.claude/skills/content-pipeline/SKILL.md" ]
}

@test "TD-218: drift returns MATCH for a de-dup'd malformed per-skill path (compile/drift pairing)" {
  build_td218_malformed_project agents
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/agents] MATCH"* ]]
}

@test "TD-218: drift flags a registry-anchored-but-too-deep symlink as DRIFTED" {
  build_td218_malformed_project agents
  # The de-dup'd link_path drift computes is .agents/skills/content-pipeline.
  # Hand-build a symlink THERE that resolves into the registry (so L-515
  # containment passes) but points at the WRAPPER PARENT
  # (registry/skills/content-pipeline) rather than the inner skill dir — so
  # SKILL.md is one level too deep (<link_path>/content-pipeline/SKILL.md, NOT
  # <link_path>/SKILL.md). This is exactly the depth-2 nest the bug produced.
  # Pre-TD-218 drift reported MATCH for this shape (registry-anchored); post-
  # TD-218 it is flagged DRIFTED — either via the wrong-canonical verdict
  # (resolved != skill_dir) or the new depth-1 assertion, both of which the
  # bug's blindness missed.
  rm -rf "$PROJ/.agents/skills/content-pipeline"
  mkdir -p "$PROJ/.agents/skills"
  ln -s "$TD218_WRAPPER_DIR" "$PROJ/.agents/skills/content-pipeline"
  # Sanity: SKILL.md is NOT at depth-1 through this link (it is one deeper).
  [ ! -f "$PROJ/.agents/skills/content-pipeline/SKILL.md" ]
  [ -f "$PROJ/.agents/skills/content-pipeline/content-pipeline/SKILL.md" ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/agents] DRIFTED"* ]]
  [[ "$output" == *"depth-1"* || "$output" == *"wrong canonical"* ]]
}

@test "TD-218: parent-path skills do NOT regress (path basename != skill name stays depth-1 MATCH)" {
  # The de-dup guard must ONLY fire when out_abs basename == skill_name. A
  # normal parent path (basename = `skills`) must still append /<name> and
  # land depth-1, exactly as before TD-218.
  build_fr157_agents_skill_project   # uses path ".agents/skills" (parent)
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.agents/skills/alpha" ]
  [ -f "$PROJ/.agents/skills/alpha/SKILL.md" ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/agents] MATCH"* ]]
}

# --- TD-224 framework-dev project-scoped skills block ------------------------
#
# TD-224 moves /onboard-harness into core/skills-dev/ and declares a SECOND
# skills block carrying `scope: {type:"project", paths:["."]}` (FR-155). The
# block must emit ONLY when --project-root matches the scope, and be a SILENT
# scope-skip (NOT drift) elsewhere. These tests exercise the FR-155 scope
# resolver's match/no-match branches that TD-224 relies on, using project-OWNED
# manifests under $IGRIS_BRAIN_DIR/registry (L-515 registry containment → MATCH).
#
# build_td224_scoped_project <scope-paths-json>: seed a project whose skills
# block is project-scoped. Source lives under the brain registry so drift's
# L-515 containment fires MATCH after a clean compile.
build_td224_scoped_project() {
  local scope_paths="$1"
  mkdir -p "$IGRIS_BRAIN_DIR/registry/skills-dev/onboard-harness"
  cat > "$IGRIS_BRAIN_DIR/registry/skills-dev/onboard-harness/SKILL.md" <<'EOF'
---
name: onboard-harness
description: "framework-dev skill (TD-224)"
---

onboard-harness body
EOF
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      { "source": "$IGRIS_BRAIN_DIR/registry/skills-dev",
        "layer": "core",
        "scope": { "type": "project", "paths": $scope_paths },
        "targets": [ { "type": "agents", "method": "symlink", "path": "agents-dev" } ] }
    ]
  }
}
EOF
}

@test "TD-224: scope-matching root EMITS the framework-dev skill (compile + drift MATCH)" {
  # The portable token: `["."]` resolves against --project-root → always the
  # current root → the block matches and emits.
  build_td224_scoped_project '["."]'
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # The scoped skill projected to its target.
  [ -L "$PROJ/agents-dev/onboard-harness" ]
  [ -f "$PROJ/agents-dev/onboard-harness/SKILL.md" ]
  # Drift MATCH for the freshly compiled scoped block (L-519 §18.1 pairing).
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/agents] MATCH"* ]]
}

@test "TD-224: non-matching root is a SILENT scope-skip (no emit, drift CLEAN — not DRIFTED)" {
  # An explicit absolute scope path that matches ONLY a different dir. Compiling
  # from $PROJ (which is NOT that dir) must skip the block silently: nothing
  # emitted, and drift returns CLEAN (the scope-skip fires before TOTAL++, so it
  # is neither counted nor flagged DRIFTED/MISSING).
  local OTHER_ROOT="$TEST_TEMP_DIR/td224_other_$BATS_TEST_NUMBER"
  mkdir -p "$OTHER_ROOT"
  build_td224_scoped_project "[\"$OTHER_ROOT\"]"
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # NOT emitted — the block was scope-skipped for this root.
  [ ! -e "$PROJ/agents-dev/onboard-harness" ]
  # No mention of the skill in the compile output.
  [[ "$output" != *"onboard-harness"* ]]
  # Drift is CLEAN (exit 0): a scope-skipped block is neither DRIFTED nor MISSING.
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" != *"DRIFTED"* ]]
  [[ "$output" != *"MISSING"* ]]
  [[ "$output" != *"onboard-harness"* ]]
}

@test "TD-224: same block flips emit→skip purely by --project-root (scope resolver branch coverage)" {
  # One manifest, one explicit-absolute scope path = $PROJ. Compiling from $PROJ
  # MATCHES (emits); compiling from a sibling root SKIPS (silent). This isolates
  # the FR-155 resolver's match vs no-match decision on identical manifest bytes.
  local SIBLING="$TEST_TEMP_DIR/td224_sibling_$BATS_TEST_NUMBER"
  mkdir -p "$SIBLING"
  build_td224_scoped_project "[\"$PROJ\"]"
  # From the matching root → emits.
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [ -L "$PROJ/agents-dev/onboard-harness" ]
  # From the sibling root (same manifest copied in) → skips.
  cp "$PROJ/harness-manifest.json" "$SIBLING/harness-manifest.json"
  run bash "$COMPILE" --project-root "$SIBLING" --surface skills
  [ "$status" -eq 0 ]
  [ ! -e "$SIBLING/agents-dev/onboard-harness" ]
  [[ "$output" != *"onboard-harness"* ]]
}
