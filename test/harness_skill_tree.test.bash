#!/usr/bin/env bats

# harness_skill_tree.test.bash — TD-201 skill TREE vendor + tree drift verify.
#
# TD-201 ports the FR-156 agent tree pre-check to the surfaces.skills loop.
# Detects direct edits to the loadout-vendored skill copy (the 2026-06-01
# Codex incident — a sentry-skipping operator hand-edit went silent because
# the per-target FR-153 verdict only sees the symlink, not the skill tree).
# The tree pre-check pairs `hash_agent_tree` over the recorded path-origin
# source dir against the loadout-vendored skill dir.
#
# These tests are end-to-end against the bash drift adapter with a
# synthesized vendored loadout + a recorded `origins.json[skill:<name>]`:
#
#   1. MATCH when source and loadout agree.
#   2. DRIFTED when the SOURCE side is mutated post-add.
#   3. DRIFTED when the REGISTRY copy is mutated (the Codex incident proof).
#   4. DRIFTED when a file is ADDED to source — `+ (only in source)` line.
#   5. DRIFTED when a file is REMOVED from source — `- (only in loadout)`.
#   6. Core skill (no `skill:<name>` origin) → silently skipped (no tree
#      verdict in output).
#   7. Skip-list parity — `.DS_Store`, `MAINTAINING.md`, `__pycache__/x.pyc`
#      sprinkled into one side only must NOT flip the verdict.
#   8. Tree-verdict dedup — a 3-target personal skill block fires ONE tree
#      verdict, not three (sanity case per plan §5).

load test_helper

setup() {
  # TD-282: sandbox HOME FIRST — BEFORE the unconditional skip below — so even if
  # the FR-212d skip is ever lifted, every `skills` delegate a compile/check
  # dispatches writes into a PER-TEST temp store, NEVER the developer's real
  # ~/.claude/skills / ~/.agents/skills. Mirrors add_surfaces.test.bash. The
  # outer `HOME=$(mktemp -d) bats` wrapper is belt; this in-test export is
  # suspenders (and it survives the skip ever being removed).
  SANDBOX_HOME="$TEST_TEMP_DIR/home_$BATS_TEST_NUMBER"
  mkdir -p "$SANDBOX_HOME/.claude/skills" "$SANDBOX_HOME/.agents/skills"
  export HOME="$SANDBOX_HOME"

  # FR-212d Phase 2: the TD-201 skill TREE pre-check lived in the custom
  # `verify_skills` body, which was DELETED when skills projection moved to the
  # `skills` CLI delegate (the delegate owns placement + freshness; there is no
  # loadout-vendored-copy-vs-source tree drift in the delegate model — the tool
  # re-projects from the source root). This suite is retired with the custom
  # body. Delegate skills drift is the tool's idempotent re-check (covered by
  # fr212-smoke + skills-delegate.test.ts).
  skip "FR-212d: TD-201 skill tree pre-check retired with the custom verify_skills body"

  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMMON="$ADAPTERS/_common.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  SCHEMA="$ADAPTERS/manifest.schema.json"

  [ -f "$COMMON" ] || skip "_common.sh missing at $COMMON"
  [ -f "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  [ -f "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  require_python3

  # Isolate from the dev machine's brain: the operator's FR-146 personal
  # overlay manifest at ~/.igris/loadout/harness-manifest.personal.json
  # auto-merges into every test's manifest otherwise. Mirror the
  # harness_agent_tree.test.bash + harness_skills.test.bash pattern.
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN" "$ISOLATED_BRAIN/loadout/skills"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  PROJ="$TEST_TEMP_DIR/skill_tree_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ"
}

teardown() {
  [ -n "${PROJ:-}" ] && [ -d "$PROJ" ] && rm -rf "$PROJ"
  [ -n "${SANDBOX_HOME:-}" ] && [ -d "$SANDBOX_HOME" ] && rm -rf "$SANDBOX_HOME"
  return 0
}

# ---------- helpers ----------------------------------------------------------

# Synthesize a personal skill state: a loadout-vendored copy +
# recorded path-origin + manifest. Mirrors what `igris loadout add-skill`
# writes (bash drift-adapter test ⇒ bash setup).
#
# Args:
#   $1 name             — skill name (e.g. demo, multi)
#   $2 source_dir       — operator's source dir holding the SKILL.md (and
#                          optional siblings). NOT under the loadout.
#   $3 target_kind      — claude | agents | opencode (single-target shorthand)
build_personal_skill_tree() {
  local name="$1"
  local source_dir="$2"
  local target_kind="$3"

  # Mirror the real `igris loadout add-skill` layout (L-517 + harness-registry
  # test line 1464): the block's `source` is `<brain>/loadout/skills/<name>`
  # and the SKILL.md lives at `<source>/<name>/SKILL.md` (double-nesting so
  # the FR-153 `find -mindepth 2 -maxdepth 2 -name SKILL.md` walk resolves).
  local block_source="$IGRIS_BRAIN_DIR/loadout/skills/$name"
  local loadout_dir="$block_source/$name"
  mkdir -p "$loadout_dir"
  cp -R "$source_dir/." "$loadout_dir/"

  # Record the origin (origins.json shape — keyed `skill:<name>`). The hash
  # is computed over the BLOCK SOURCE (the dir the tree pre-check hashes —
  # i.e. `<brain>/loadout/skills/<name>` containing `<name>/{SKILL.md, ...}`).
  local origins_path="$IGRIS_BRAIN_DIR/loadout/origins.json"
  if [ ! -f "$origins_path" ]; then
    printf '{}\n' > "$origins_path"
  fi
  local tree_hash
  tree_hash=$(bash -c "source '$COMMON' && hash_agent_tree '$block_source'")
  python3 - "$origins_path" "$name" "$source_dir" "$tree_hash" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
data["skill:" + sys.argv[2]] = {
    "type": "path",
    "dir": sys.argv[3],
    "hash": sys.argv[4],
}
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
PY

  # Manifest declaring a personal skills block. `source` points at the
  # single-skill loadout dir (`<brain>/loadout/skills/<name>`) — this is
  # the shape `igris loadout add-skill` writes (see harness-registry.test.ts
  # line 1464). The basename IS the skill name, which is what the TD-201
  # tree pre-check dedups on. Layer=personal gates the tree pre-check on.
  local target_path target_method
  target_method="symlink"
  case "$target_kind" in
    claude)   target_path=".claude/skills" ;;
    agents)   target_path=".agents/skills" ;;
    opencode) target_path=".config/opencode/command"; target_method="command" ;;
  esac
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "$block_source",
        "layer": "personal",
        "targets": [
          { "type": "$target_kind", "method": "$target_method", "path": "$target_path" }
        ]
      }
    ]
  }
}
EOF
  # Compile so the per-target FR-153 verdict is MATCH (tree pre-check and
  # FR-153 verdict are orthogonal — we want both to fire as expected).
  env HOME="$SANDBOX_HOME" bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" --target "$target_kind" >/dev/null
}

# ---------- end-to-end drift integration -------------------------------------

@test "TD-201 case 1: MATCH when source and loadout agree" {
  local src="$PROJ/src_match"
  mkdir -p "$src"
  cat > "$src/SKILL.md" <<'EOF'
---
name: alpha
description: match case
---

# Alpha skill body.
EOF

  build_personal_skill_tree "alpha" "$src" "claude"

  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[alpha/tree] MATCH"* ]]
  # Orthogonal per-target FR-153 verdict still fires MATCH.
  [[ "$output" == *"[skills/claude] MATCH"* ]]
}

@test "TD-201 case 2: DRIFTED when SOURCE content mutated post-add" {
  local src="$PROJ/src_mut"
  mkdir -p "$src/lib"
  cat > "$src/SKILL.md" <<'EOF'
---
name: beta
description: source mutation
---

# beta
EOF
  printf 'v1\n' > "$src/lib/helper.md"

  build_personal_skill_tree "beta" "$src" "claude"

  # Sanity: starts MATCH.
  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[beta/tree] MATCH"* ]]

  # Mutate the SOURCE side post-add.
  printf 'v2-CHANGED\n' > "$src/lib/helper.md"
  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[beta/tree] DRIFTED"* ]]
  [[ "$output" == *"lib/helper.md"* ]]
  [[ "$output" == *"contents differ"* ]]
}

@test "TD-201 case 3: DRIFTED when REGISTRY copy mutated (the 2026-06-01 Codex incident proof)" {
  local src="$PROJ/src_codex"
  mkdir -p "$src"
  cat > "$src/SKILL.md" <<'EOF'
---
name: codex-incident
description: loadout-side hand edit
---

# original body
EOF

  build_personal_skill_tree "codex-incident" "$src" "claude"

  # The Codex incident reproduction: operator hand-edits the loadout-vendored
  # copy directly. Pre-TD-201 this drift was silent (FR-153 only checks the
  # symlink, not the tree). TD-201's tree pre-check MUST flip to DRIFTED here.
  # NOTE: the loadout layout is `<brain>/loadout/skills/<name>/<name>/SKILL.md`
  # (double-nested per the FR-153 `find -mindepth 2` walk); the per-block
  # source is the outer dir, the actual file is one level deeper.
  printf 'HAND-EDITED IN REGISTRY\n' \
    > "$IGRIS_BRAIN_DIR/loadout/skills/codex-incident/codex-incident/SKILL.md"

  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[codex-incident/tree] DRIFTED"* ]]
  [[ "$output" == *"SKILL.md"* ]]
  [[ "$output" == *"contents differ"* ]]
}

@test "TD-201 case 4: DRIFTED when source file ADDED — '+ (only in source)' diff sub-line" {
  local src="$PROJ/src_added"
  mkdir -p "$src"
  cat > "$src/SKILL.md" <<'EOF'
---
name: added
description: file added
---

# added
EOF

  build_personal_skill_tree "added" "$src" "claude"

  # Drop a NEW sibling file into the source post-add.
  printf 'extras body\n' > "$src/extras.md"
  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[added/tree] DRIFTED"* ]]
  [[ "$output" == *"+ extras.md (only in source)"* ]]
}

@test "TD-201 case 5: DRIFTED when source file REMOVED — '- (only in loadout)' diff sub-line" {
  local src="$PROJ/src_removed"
  mkdir -p "$src"
  cat > "$src/SKILL.md" <<'EOF'
---
name: removed
description: file removed
---

# removed
EOF
  printf 'extra body\n' > "$src/extra.md"

  build_personal_skill_tree "removed" "$src" "claude"

  # Delete the sibling file from source post-add.
  rm "$src/extra.md"
  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"[removed/tree] DRIFTED"* ]]
  [[ "$output" == *"- extra.md (only in loadout)"* ]]
}

@test "TD-201 case 6: Core skill (no skill:<name> origin) → silently skipped (no tree verdict)" {
  # Set up the skill in the loadout (so the FR-153 per-target verdict
  # succeeds) but declare it as a CORE-layer skills block — no `origins.json`
  # entry recorded. The tree pre-check must be a silent no-op for core skills.
  local loadout_dir="$IGRIS_BRAIN_DIR/loadout/skills/coreskill"
  mkdir -p "$loadout_dir"
  cat > "$loadout_dir/SKILL.md" <<'EOF'
---
name: coreskill
description: core layer
---

# core
EOF

  local skills_root="$IGRIS_BRAIN_DIR/loadout/skills"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "$skills_root",
        "layer": "core",
        "targets": [
          { "type": "claude", "method": "symlink", "path": ".claude/skills" }
        ]
      }
    ]
  }
}
EOF
  env HOME="$SANDBOX_HOME" bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" --target claude >/dev/null

  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  # The per-target FR-153 verdict still fires (orthogonal).
  [[ "$output" == *"[skills/claude] MATCH"* ]]
  # No tree verdict emitted for the core skill (silent skip).
  [[ "$output" != *"[coreskill/tree]"* ]]
}

@test "TD-201 case 7: skip-list parity — .DS_Store / MAINTAINING.md / __pycache__ on one side only stays MATCH" {
  local src="$PROJ/src_skip"
  mkdir -p "$src"
  cat > "$src/SKILL.md" <<'EOF'
---
name: skipped
description: skip-list parity
---

# skipped
EOF

  build_personal_skill_tree "skipped" "$src" "claude"

  # Sanity: starts MATCH.
  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skipped/tree] MATCH"* ]]

  # Sprinkle ONLY skip-list cruft into the SOURCE side (asymmetric). If the
  # skip-list works the verdict stays MATCH — the cruft is excluded from the
  # hash basis on both sides regardless of which side carries it.
  mkdir -p "$src/__pycache__" "$src/node_modules/foo" "$src/.git"
  printf 'cruft\n' > "$src/.DS_Store"
  printf 'cruft\n' > "$src/MAINTAINING.md"
  printf 'cruft\n' > "$src/.gitignore"
  printf 'cruft\n' > "$src/__pycache__/x.pyc"
  printf 'cruft\n' > "$src/node_modules/foo/index.js"
  printf 'cruft\n' > "$src/.git/HEAD"
  printf 'cruft\n' > "$src/top.pyc"

  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skipped/tree] MATCH"* ]]
}

@test "TD-201 case 8: tree verdict fires ONCE per skill across multi-target rows (dedup sanity)" {
  # A single personal skill block with the 3 live targets (claude+agents+
  # opencode — FR-202 M1 retired the standalone codex/gemini skill targets).
  # The tree pre-check is keyed on the skill name (basename of the loadout-
  # vendored source dir) so the verdict must fire exactly once across all
  # three rows.
  local src="$PROJ/src_multi"
  mkdir -p "$src"
  cat > "$src/SKILL.md" <<'EOF'
---
name: multi
description: dedup
---

# multi
EOF

  # Mirror the double-nested loadout layout `igris loadout add-skill` writes:
  # block source = `<brain>/loadout/skills/<name>` containing `<name>/SKILL.md`.
  local block_source="$IGRIS_BRAIN_DIR/loadout/skills/multi"
  local loadout_dir="$block_source/multi"
  mkdir -p "$loadout_dir"
  cp -R "$src/." "$loadout_dir/"
  local origins_path="$IGRIS_BRAIN_DIR/loadout/origins.json"
  printf '{}\n' > "$origins_path"
  local tree_hash
  tree_hash=$(bash -c "source '$COMMON' && hash_agent_tree '$block_source'")
  python3 - "$origins_path" "multi" "$src" "$tree_hash" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
data["skill:" + sys.argv[2]] = {"type": "path", "dir": sys.argv[3], "hash": sys.argv[4]}
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
PY

  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "$block_source",
        "layer": "personal",
        "targets": [
          { "type": "claude",   "method": "symlink", "path": ".claude/skills" },
          { "type": "agents",   "method": "symlink", "path": ".agents/skills" },
          { "type": "opencode", "method": "command", "path": ".config/opencode/command" }
        ]
      }
    ]
  }
}
EOF
  # Compile the whole skills surface in one pass (the `--target` flag selects an
  # AGENT-harness name, not a skill target type, so it cannot scope to the
  # agents/opencode skill targets — recompile all of them together).
  env HOME="$SANDBOX_HOME" bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" --surface skills >/dev/null

  run env HOME="$SANDBOX_HOME" bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  # Exactly ONE tree verdict despite three target rows.
  local tree_count
  tree_count=$(printf '%s\n' "$output" | grep -c '\[multi/tree\] MATCH' || true)
  [ "$tree_count" -eq 1 ]
  # Each per-target verdict still fires (orthogonal to the tree pre-check).
  [[ "$output" == *"[skills/claude]"* ]]
  [[ "$output" == *"[skills/agents]"* ]]
  [[ "$output" == *"[skills/opencode]"* ]]
}
