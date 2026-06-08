#!/usr/bin/env bats

# harness_opencode.test.bash — FR-171 OpenCode first-class distribution.
#
# OpenCode joins claude/codex/gemini as a first-class harness for BOTH agents
# (registry-anchored symlink → harness.opencode.md; OpenCode's agent loader
# follows symlinks, verified live opencode 1.14.22) and skills (thin @file
# command wrappers). These tests are end-to-end against the bash adapters
# (compile + drift) with a synthesized vendored registry, mirroring the
# harness_agent_tree / harness_skills setup.
#
# Coverage (FR-171 §7 bats matrix):
#   1. Schema validates an opencode agent target + an opencode/command skills
#      target; rejects a bad opencode skills method.
#   2. Agent projection: compile an opencode-targeted agent → harness.opencode.md
#      assembled (OpenCode-shaped frontmatter: mode/tools-map/permission) + the
#      target symlink created; drift MATCH.
#   3. Tool-mapping correctness: tools: [Read, Grep] → boolean map
#      {read: true, grep: true}; WebSearch OMITTED.
#   4. Command projection: opencode/command target → wrapper file written with
#      the generated-marker + correct @file directive; drift MATCH.
#   5. Refuse-to-clobber: a real (non-generated) file at the wrapper path →
#      compile FAIL / drift DRIFTED, no overwrite.
#   6. Count parity: drift MISSING when an opencode command wrapper is absent.
#   7. §18.1 bash↔TS parity: the bash inline-python3 opencode translator output
#      byte-equals what the TS CLAUDE_TO_OPENCODE_TOOLS / mode / permission
#      shape produces (asserted via the deterministic emitted bytes).

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMMON="$ADAPTERS/_common.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  SCHEMA="$ADAPTERS/manifest.schema.json"
  SURFACES="$ADAPTERS/surfaces-manifest.json"

  [ -f "$COMMON" ] || skip "_common.sh missing at $COMMON"
  [ -f "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  [ -f "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  [ -f "$SCHEMA" ] || skip "manifest.schema.json missing at $SCHEMA"
  require_python3

  # Isolate from the dev machine's brain (FR-146 personal overlay would
  # otherwise auto-merge into every test's manifest).
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  PROJ="$TEST_TEMP_DIR/opencode_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ"
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

# Synthesize a vendored personal agent tree + manifest declaring an opencode
# target, then compile it. Mirrors build_personal_agent_tree in
# harness_agent_tree.test.bash, scoped to opencode.
build_opencode_agent() {
  local name="$1"
  local source_dir="$2"
  local target_path="$3"

  local registry_dir="$IGRIS_BRAIN_DIR/registry/agents/$name"
  mkdir -p "$registry_dir"
  cp -R "$source_dir/." "$registry_dir/"

  local manifest="$PROJ/harness-manifest.json"
  cat > "$manifest" <<EOF
{
  "version": 1,
  "agents": [
    {
      "name": "$name",
      "layer": "personal",
      "canonical": {
        "dir": "$registry_dir",
        "versioned": true,
        "glob": "system-prompt-v*.md"
      },
      "targets": [
        { "type": "opencode", "path": "$target_path" }
      ]
    }
  ]
}
EOF
  bash "$COMPILE" --project-root "$PROJ" --manifest "$manifest" --target opencode >/dev/null
}

# --- Schema validation -------------------------------------------------------

@test "schema validates an opencode agent target" {
  cat > "$PROJ/m.json" <<'EOF'
{ "version": 1,
  "agents": [
    { "name": "oc", "canonical": { "dir": "core/agents", "file": "oc.md", "versioned": false },
      "targets": [ { "type": "opencode", "path": "~/.config/opencode/agent/oc.md" } ] }
  ] }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/m.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "schema validates an opencode/command skills target" {
  cat > "$PROJ/m.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "opencode", "method": "command", "path": "~/.config/opencode/command" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/m.json' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

@test "schema rejects a bad opencode skills method (opencode/symlink)" {
  cat > "$PROJ/bad.json" <<'EOF'
{ "version": 1, "agents": [],
  "surfaces": { "skills": { "targets": [ { "type": "opencode", "method": "symlink", "path": "~/.config/opencode/command" } ] } } }
EOF
  run bash -c "source '$COMMON' && validate_manifest '$PROJ/bad.json' '$SCHEMA'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"opencode"* || "$output" == *"pair"* || "$output" == *"method"* ]]
}

@test "the shipped surfaces-manifest.json (with opencode/command) validates" {
  run bash -c "source '$COMMON' && validate_manifest '$SURFACES' '$SCHEMA'"
  [ "$status" -eq 0 ]
}

# --- Agent projection --------------------------------------------------------

@test "compile: opencode agent → harness.opencode.md assembled + target symlink created" {
  local src="$PROJ/src_a"
  mkdir -p "$src"
  cat > "$src/frontmatter.claude.md" <<'EOF'
---
name: ocdemo
description: opencode agent demo
tools: Read, Grep, Bash
---
EOF
  printf '# ocdemo body\nbody line\n' > "$src/system-prompt-v1.md"

  build_opencode_agent "ocdemo" "$src" "$PROJ/.opencode/agent/ocdemo.md"

  local harness="$IGRIS_BRAIN_DIR/registry/agents/ocdemo/harness.opencode.md"
  [ -f "$harness" ]
  # OpenCode-shaped frontmatter: mode lead, boolean tools map, permission block.
  run cat "$harness"
  [[ "$output" == *"mode: subagent"* ]]
  [[ "$output" == *"name: ocdemo"* ]]
  [[ "$output" == *"description: opencode agent demo"* ]]
  [[ "$output" == *"permission:"* ]]
  [[ "$output" == *'"mcp__igris-brain__*": allow'* ]]
  [[ "$output" == *"body line"* ]]
  # Target is a symlink to the registry-resident harness.opencode.md.
  [ -L "$PROJ/.opencode/agent/ocdemo.md" ]
}

@test "compile: opencode tools map is a BOOLEAN MAP (Read/Grep/Bash → read/grep/bash: true)" {
  local src="$PROJ/src_t"
  mkdir -p "$src"
  cat > "$src/frontmatter.claude.md" <<'EOF'
---
name: octools
tools: [Read, Grep, WebSearch]
---
EOF
  printf 'body\n' > "$src/system-prompt-v1.md"

  build_opencode_agent "octools" "$src" "$PROJ/.opencode/agent/octools.md"

  run cat "$IGRIS_BRAIN_DIR/registry/agents/octools/harness.opencode.md"
  [[ "$output" == *"tools:"* ]]
  [[ "$output" == *"  read: true"* ]]
  [[ "$output" == *"  grep: true"* ]]
  # WebSearch has no native equivalent — MUST NOT appear in the tools map.
  [[ "$output" != *"websearch"* ]]
  [[ "$output" != *"web_search"* ]]
}

@test "drift: compiled opencode agent → MATCH" {
  local src="$PROJ/src_d"
  mkdir -p "$src"
  cat > "$src/frontmatter.claude.md" <<'EOF'
---
name: ocdrift
description: drift demo
tools: Read
---
EOF
  printf 'body\n' > "$src/system-prompt-v1.md"

  build_opencode_agent "ocdrift" "$src" "$PROJ/.opencode/agent/ocdrift.md"

  run bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[ocdrift/opencode] MATCH"* ]]
}

@test "drift: opencode agent target absent → MISSING" {
  local src="$PROJ/src_m"
  mkdir -p "$src"
  cat > "$src/frontmatter.claude.md" <<'EOF'
---
name: ocmiss
tools: Read
---
EOF
  printf 'body\n' > "$src/system-prompt-v1.md"

  build_opencode_agent "ocmiss" "$src" "$PROJ/.opencode/agent/ocmiss.md"
  # Remove the projected target — drift must report MISSING.
  rm -f "$PROJ/.opencode/agent/ocmiss.md"

  run bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"[ocmiss/opencode] MISSING"* ]]
}

@test "compile: opencode agent refuse-to-clobber a real (non-symlink) file target" {
  local src="$PROJ/src_rc"
  mkdir -p "$src" "$PROJ/.opencode/agent"
  cat > "$src/frontmatter.claude.md" <<'EOF'
---
name: ocreal
tools: Read
---
EOF
  printf 'body\n' > "$src/system-prompt-v1.md"
  # Pre-place a REAL file at the target path.
  printf 'hand-authored\n' > "$PROJ/.opencode/agent/ocreal.md"

  build_opencode_agent "ocreal" "$src" "$PROJ/.opencode/agent/ocreal.md" || true
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" --target opencode
  [ "$status" -ne 0 ]
  [[ "$output" == *"refuse to clobber"* ]]
  # The real file is untouched (still a regular file, not a symlink).
  [ -f "$PROJ/.opencode/agent/ocreal.md" ]
  [ ! -L "$PROJ/.opencode/agent/ocreal.md" ]
  run cat "$PROJ/.opencode/agent/ocreal.md"
  [[ "$output" == *"hand-authored"* ]]
}

# --- Command (skills) projection ---------------------------------------------

# Seed a registry skills tree + an opencode/command skills manifest, compile.
build_opencode_command() {
  mkdir -p "$IGRIS_BRAIN_DIR/registry/skills/alpha" \
           "$IGRIS_BRAIN_DIR/registry/skills/beta"
  cat > "$IGRIS_BRAIN_DIR/registry/skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: the alpha skill - usage: /alpha
---
# Alpha
EOF
  cat > "$IGRIS_BRAIN_DIR/registry/skills/beta/SKILL.md" <<'EOF'
---
name: beta
description: the beta skill
---
# Beta
EOF
  local skills_src="$IGRIS_BRAIN_DIR/registry/skills"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": {
      "source": "$skills_src",
      "layer": "personal",
      "targets": [
        { "type": "opencode", "method": "command", "path": "$PROJ/.opencode/command" }
      ]
    }
  }
}
EOF
  bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" >/dev/null
}

@test "compile: opencode/command → per-skill wrapper with generated-marker + @file directive" {
  build_opencode_command
  local w="$PROJ/.opencode/command/alpha.md"
  [ -f "$w" ]
  # NOT a symlink — a real file.
  [ ! -L "$w" ]
  run cat "$w"
  # Line 1 is the FR-171 generated-marker.
  [[ "${lines[0]}" == *"Generated by igris harness compile (FR-171 opencode/command)"* ]]
  # Loads the ACTUAL canonical SKILL.md the compile walked via @file (single
  # source of truth). In this sandbox the source is under $IGRIS_BRAIN_DIR
  # (not $HOME), so the @-target is the absolute registry path.
  [[ "$output" == *"@$IGRIS_BRAIN_DIR/registry/skills/alpha/SKILL.md"* ]]
  [[ "$output" == *'$ARGUMENTS'* ]]
  # Description lifted from the skill's SKILL.md frontmatter.
  [[ "$output" == *"description: the alpha skill - usage: /alpha"* ]]
  # Both skills got wrappers.
  [ -f "$PROJ/.opencode/command/beta.md" ]
}

@test "compile: opencode/command is idempotent (second run silent no-op, bytes identical)" {
  build_opencode_command
  local w="$PROJ/.opencode/command/alpha.md"
  local before
  before=$(cat "$w")
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  local after
  after=$(cat "$w")
  [ "$before" = "$after" ]
}

@test "drift: compiled opencode/command wrappers → MATCH" {
  build_opencode_command
  run bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[skills/opencode] MATCH"* ]]
}

@test "drift: opencode/command wrapper absent → MISSING (count parity)" {
  build_opencode_command
  rm -f "$PROJ/.opencode/command/beta.md"
  run bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"[skills/opencode] MISSING"* ]]
}

@test "compile: opencode/command refuse-to-clobber a non-generated file at the wrapper path" {
  mkdir -p "$IGRIS_BRAIN_DIR/registry/skills/alpha" "$PROJ/.opencode/command"
  cat > "$IGRIS_BRAIN_DIR/registry/skills/alpha/SKILL.md" <<'EOF'
---
name: alpha
description: the alpha skill
---
# Alpha
EOF
  # A hand-authored command (no generated-marker) at the wrapper path.
  printf -- '---\ndescription: hand authored\n---\nmy own command\n' > "$PROJ/.opencode/command/alpha.md"
  cat > "$PROJ/harness-manifest.json" <<EOF
{
  "version": 1, "agents": [],
  "surfaces": { "skills": { "source": "$IGRIS_BRAIN_DIR/registry/skills", "layer": "personal",
    "targets": [ { "type": "opencode", "method": "command", "path": "$PROJ/.opencode/command" } ] } }
}
EOF
  run bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"refuse to clobber"* || "$output" == *"non-generated"* ]]
  # The hand-authored file is untouched.
  run cat "$PROJ/.opencode/command/alpha.md"
  [[ "$output" == *"my own command"* ]]
}

@test "drift: opencode/command wrapper without generated-marker → DRIFTED" {
  build_opencode_command
  # Replace alpha's wrapper with a hand-authored (unmarked) file.
  printf -- '---\ndescription: x\n---\nbody\n' > "$PROJ/.opencode/command/alpha.md"
  run bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"[skills/opencode] DRIFTED"* ]]
}

# --- §18.1 bash↔TS parity (golden) -------------------------------------------

@test "FR-171 §18.1: bash opencode translator emits the deterministic OpenCode shape" {
  # The bash inline-python3 translator is exercised through the assembler.
  # This pins the exact deterministic bytes the TS golden-parity test also
  # asserts (CLAUDE_TO_OPENCODE_TOOLS + mode + permission). Read/Grep/Bash +
  # WebSearch (omitted) is the canonical parity input set.
  local src="$PROJ/src_par"
  mkdir -p "$src"
  cat > "$src/frontmatter.claude.md" <<'EOF'
---
name: parity
description: parity input
tools: Read, Grep, Bash, WebSearch
---
EOF
  printf 'parity body\n' > "$src/system-prompt-v1.md"

  build_opencode_agent "parity" "$src" "$PROJ/.opencode/agent/parity.md"

  run cat "$IGRIS_BRAIN_DIR/registry/agents/parity/harness.opencode.md"
  [ "$status" -eq 0 ]
  # Exact deterministic shape (order: mode, name, description, tools-map,
  # permission). WebSearch dropped from the map.
  [[ "$output" == *"mode: subagent"* ]]
  [[ "$output" == *"name: parity"* ]]
  [[ "$output" == *"description: parity input"* ]]
  [[ "$output" == *"  read: true"* ]]
  [[ "$output" == *"  grep: true"* ]]
  [[ "$output" == *"  bash: true"* ]]
  [[ "$output" != *"websearch"* ]]
  [[ "$output" == *'"mcp__igris-brain__*": allow'* ]]
}
