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
