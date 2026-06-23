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
#   3. check_harness_drift flags a mutated projected skill artifact (the
#      agents + claude per-skill symlinks) and returns to MATCH after recompile.
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
  # FR-202 M1: the live skills triad uses the symlink/command methods. Source
  # is the ABSOLUTE registry path — satisfies agents/symlink's D2 absolute-path
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
        { "type": "agents",  "method": "symlink",  "path": ".agents/skills" },
        { "type": "claude", "method": "symlink",  "path": ".claude/skills" }
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
  "surfaces": { "skills": { "targets": [ { "type": "claude", "path": ".claude/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"method"* ]]
}

@test "schema rejects a bad skills target 'method' enum" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "claude", "method": "frobnicate", "path": ".claude/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"frobnicate"* || "$output" == *"method"* ]]
}

@test "schema rejects a bad skills target 'type' enum" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "frobtype", "method": "symlink", "path": ".x/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"frobtype"* || "$output" == *"type"* || "$output" == *"pair"* ]]
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
  "surfaces": { "skills": { "targets": [ { "type": "claude", "path": ".claude/skills" } ] } } }
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

@test "compile projects the skills surface (agents + claude per-skill symlinks)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills/agents"* ]]
  [[ "$output" == *"skills/claude"* ]]
  # FR-202 M1: per-skill symlinks under .agents/skills/ + .claude/skills/.
  [ -L "$PROJ/.agents/skills/alpha" ]
  [ -L "$PROJ/.agents/skills/beta" ]
  [ -L "$PROJ/.claude/skills/alpha" ]
  [ -L "$PROJ/.claude/skills/beta" ]
}

@test "skills compile is idempotent (same inode on re-run)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  local agents_inode_before claude_inode_before
  agents_inode_before="$(stat -f '%i' "$PROJ/.agents/skills/alpha" 2>/dev/null \
                       || stat -c '%i' "$PROJ/.agents/skills/alpha")"
  claude_inode_before="$(stat -f '%i' "$PROJ/.claude/skills/alpha" 2>/dev/null \
                        || stat -c '%i' "$PROJ/.claude/skills/alpha")"

  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]

  local agents_inode_after claude_inode_after
  agents_inode_after="$(stat -f '%i' "$PROJ/.agents/skills/alpha" 2>/dev/null \
                      || stat -c '%i' "$PROJ/.agents/skills/alpha")"
  claude_inode_after="$(stat -f '%i' "$PROJ/.claude/skills/alpha" 2>/dev/null \
                       || stat -c '%i' "$PROJ/.claude/skills/alpha")"
  [ "$agents_inode_before" = "$agents_inode_after" ]
  [ "$claude_inode_before" = "$claude_inode_after" ]
}

@test "--surface skills compiles only the skills surface" {
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  [[ "$output" == *"skills/agents"* ]]
  [[ "$output" == *"skills/claude"* ]]
}

# --- Drift coverage ----------------------------------------------------------

@test "drift reports MATCH for a freshly compiled skills surface (exit 0)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/agents] MATCH"* ]]
  [[ "$output" == *"[skills/claude] MATCH"* ]]
}

@test "FR-157: drift flags a manually-repointed agents symlink (registry-unanchored) and recovers after recompile" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  # Repoint one of the agents skill symlinks to somewhere ELSE (outside the
  # source root); drift should flag it as registry-unanchored / mismatched.
  mkdir -p "$PROJ/elsewhere/alpha"
  rm "$PROJ/.agents/skills/alpha"
  ln -s "$PROJ/elsewhere/alpha" "$PROJ/.agents/skills/alpha"

  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/agents] DRIFTED"* ]]

  # Recompile the whole skills surface (the `--target` flag only accepts the
  # AGENT-harness names claude|codex|gemini|opencode, NOT the skill TARGET TYPE
  # `agents` — different axis; so we recompile all skill targets here).
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/agents] MATCH"* ]]
}

@test "FR-149: drift flags a mutated claude symlink (file at target instead of link)" {
  run bash "$COMPILE" --project-root "$PROJ"
  [ "$status" -eq 0 ]
  # Replace one claude symlink with a regular file → drift verdict fires.
  rm "$PROJ/.claude/skills/beta"
  echo "operator-edit-bytes" > "$PROJ/.claude/skills/beta"

  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/claude] DRIFTED"* ]]
}

@test "drift reports MISSING for a never-compiled skills surface" {
  # No compile -> no symlinks present at target paths.
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[skills/agents] MISSING"* ]]
}

# --- Overlay merge seam (FR-139) --------------------------------------------

@test "overlay merges a personal skills target additively" {
  cat > "$PROJ/base.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "skills",
    "targets": [ { "type": "agents", "method": "symlink", "path": ".agents/skills" } ] } } }
EOF
  cat > "$PROJ/overlay.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "claude", "method": "symlink", "path": ".claude/skills" } ] } } }
EOF
  run bash -c "source '$COMMON' && merge_overlay_manifest '$PROJ/base.json' '$PROJ/overlay.json'"
  [ "$status" -eq 0 ]
  [[ "$output" == *".agents/skills"* ]]
  [[ "$output" == *".claude/skills"* ]]
}

@test "overlay skill-target path collision with a core skill is a hard error" {
  cat > "$PROJ/base.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "agents", "method": "symlink", "path": ".agents/skills" } ] } } }
EOF
  cat > "$PROJ/overlay.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": {
    "targets": [ { "type": "agents", "method": "symlink", "path": ".agents/skills" } ] } } }
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
      "targets": [ { "type": "agents", "method": "symlink", "path": ".agents/core/skills" } ] },
    { "source": "skills",
      "targets": [ { "type": "claude", "method": "symlink", "path": ".claude/skills" } ] }
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
    "targets": [ { "type": "agents", "method": "symlink", "path": ".agents/skills" } ] } } }
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
      "targets": [ { "type": "agents", "method": "symlink", "path": ".agents/skills" } ] }
  ] } }
EOF
  cat > "$PROJ/overlay-array.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": [
    { "source": "skills-personal",
      "targets": [ { "type": "agents", "method": "symlink", "path": ".agents/skills" } ] }
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
  # sources. FR-202 M1: the dead gemini target is retired in favor of
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
        "targets": [ { "type": "claude", "method": "symlink", "path": "claude-core" } ] },
      { "source": "$PROJ/skills-mine",
        "layer": "personal",
        "targets": [ { "type": "claude", "method": "symlink", "path": "claude-mine" } ] }
    ]
  }
}
EOF
  run bash "$COMPILE" --project-root "$PROJ" --surface skills
  [ "$status" -eq 0 ]
  # FR-153: per-skill symlinks under each block's target dir.
  [ -L "$PROJ/claude-core/alpha" ]
  [ -L "$PROJ/claude-mine/mine" ]
  # Cross-source isolation: alpha MUST NOT be in the personal output,
  # and mine MUST NOT be in the core output.
  [ ! -e "$PROJ/claude-mine/alpha" ]
  [ ! -e "$PROJ/claude-core/mine" ]
  # Body distinctness via following the symlink to the original SKILL.md.
  grep -q "ALPHA_CORE_BODY_MARKER" "$PROJ/claude-core/alpha/SKILL.md"
  grep -q "MINE_PERSONAL_BODY_MARKER" "$PROJ/claude-mine/mine/SKILL.md"
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
        "targets": [ { "type": "claude", "method": "symlink", "path": "claude-core" } ] },
      { "source": "$IGRIS_BRAIN_DIR/registry/skills-mine", "layer": "personal",
        "targets": [ { "type": "claude", "method": "symlink", "path": "claude-mine" } ] }
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
  rm "$PROJ/claude-mine/mine"
  echo "operator-edit" > "$PROJ/claude-mine/mine"
  run bash "$GUARD" --project-root "$PROJ"
  [ "$status" -eq 1 ]
  [[ "$output" == *"DRIFTED"* ]]
  # Recompile → operator-authored file at link path → REFUSE-TO-CLOBBER.
  # The mutation must be reverted manually first (matches operator UX).
  rm "$PROJ/claude-mine/mine"
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
# FR-157 / FR-202 M1: `agents/symlink` — the cross-CLI shared `~/.agents/skills/`
# standard that codex+gemini both read natively. This is the SURVIVING guarded
# symlink target after FR-202 M1 deleted the dead standalone codex/symlink +
# gemini/symlink branches (the no-guard `claude/symlink` target is covered by
# the FR-149 section above). Asserts the D2 absolute-target inheritance.
# L-519 §18.1 compile/drift pairing.
# ---------------------------------------------------------------------------

# build_fr157_agents_skill_project: per-test fixture mirroring
# build_fr149_skill_project but emitting an agents:symlink target.
build_fr157_agents_skill_project() {
  # Clean slate (mirrors the FR-149 setup posture).
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
