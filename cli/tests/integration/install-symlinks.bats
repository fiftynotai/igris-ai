#!/usr/bin/env bats

# install-symlinks.bats — integration tests for the native TS symlink layer
# of `igris install` (M2.6/M2.10). Asserts that .claude/{agents,rules,skills}
# symlinks land correctly when the CLI fully owns the symlink layer (no shell
# script invoked).
#
# Brain core staged in $IGRIS_BRAIN_DIR via stage_brain_with_core helper
# below — minimal but realistic: a couple of agents, the universal rule, two
# skill dirs, the CLAUDE.md template.

load _helpers.bash

# Stage a brain that includes core/{agents,rules,skills,templates} so the
# native symlink layer can find sources to link. Matches stage_brain's tmp
# layout but with extras.
stage_brain_with_core() {
  stage_brain  # writes canonical-settings.json + memory/

  # Agents
  mkdir -p "$IGRIS_BRAIN_DIR/core/agents"
  printf '# architect\n' > "$IGRIS_BRAIN_DIR/core/agents/architect.md"
  printf '# forger\n'    > "$IGRIS_BRAIN_DIR/core/agents/forger.md"
  printf 'agents: []\n'  > "$IGRIS_BRAIN_DIR/core/agents/manifest.yaml"

  # Rules
  mkdir -p "$IGRIS_BRAIN_DIR/core/rules"
  printf '# universal\n' > "$IGRIS_BRAIN_DIR/core/rules/00-igris-universal.md"

  # Skills (each is a directory)
  mkdir -p "$IGRIS_BRAIN_DIR/core/skills/hunt"
  printf '# hunt skill\n' > "$IGRIS_BRAIN_DIR/core/skills/hunt/SKILL.md"
  mkdir -p "$IGRIS_BRAIN_DIR/core/skills/scan"
  printf '# scan skill\n' > "$IGRIS_BRAIN_DIR/core/skills/scan/SKILL.md"

  # CLAUDE.md template (used by claude-md.ts)
  mkdir -p "$IGRIS_BRAIN_DIR/core/templates"
  cat > "$IGRIS_BRAIN_DIR/core/templates/CLAUDE.md.tmpl" <<'TMPL'
# Igris AI Project Instructions

Igris v{{IGRIS_VERSION}}
Installed: {{INSTALL_DATE}}
TMPL
}

setup() {
  stage_brain_with_core
  export IGRIS_KEEP_BAK=0
}

@test "install creates .claude/agents/<name>.md symlinks pointing at brain agents" {
  PROJ="$(stage_project agents)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]

  [ -L "$PROJ/.claude/agents/architect.md" ]
  [ -L "$PROJ/.claude/agents/forger.md" ]
  [ -L "$PROJ/.claude/agents/manifest.yaml" ]

  # Resolved target points at the brain.
  TARGET=$(readlink "$PROJ/.claude/agents/architect.md")
  [ "$TARGET" = "$IGRIS_BRAIN_DIR/core/agents/architect.md" ]
}

@test "install creates .claude/rules/00-igris-universal.md symlink" {
  PROJ="$(stage_project rules)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]

  [ -L "$PROJ/.claude/rules/00-igris-universal.md" ]
  TARGET=$(readlink "$PROJ/.claude/rules/00-igris-universal.md")
  [ "$TARGET" = "$IGRIS_BRAIN_DIR/core/rules/00-igris-universal.md" ]
}

@test "install creates .claude/skills/<skill>/ symlinks for each skill dir" {
  PROJ="$(stage_project skills)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]

  [ -L "$PROJ/.claude/skills/hunt" ]
  [ -L "$PROJ/.claude/skills/scan" ]

  # Reading through the symlink yields the SKILL.md
  [ -f "$PROJ/.claude/skills/hunt/SKILL.md" ]
  [ -f "$PROJ/.claude/skills/scan/SKILL.md" ]
}

@test "install regenerates CLAUDE.md from template" {
  PROJ="$(stage_project claudemd)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]

  [ -f "$PROJ/CLAUDE.md" ]
  # Substituted version (any non-template version pattern X.Y.Z)
  run grep -E '^Igris v[0-9]+\.[0-9]+\.[0-9]+' "$PROJ/CLAUDE.md"
  [ "$status" -eq 0 ]
  # No template placeholders remain.
  run grep -E '\{\{IGRIS_VERSION\}\}' "$PROJ/CLAUDE.md"
  [ "$status" -ne 0 ]
}

@test "install writes .igris_version with brain_path matching IGRIS_BRAIN_DIR" {
  PROJ="$(stage_project versioned)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]

  [ -f "$PROJ/.igris_version" ]
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.igris_version')); print(d['brain_path'])"
  [ "$status" -eq 0 ]
  [ "$output" = "$IGRIS_BRAIN_DIR" ]
}

@test "re-install is idempotent — symlinks unchanged, no-op for existing matching links" {
  PROJ="$(stage_project idemlinks)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  INO_BEFORE=$(stat -f '%i' "$PROJ/.claude/agents/architect.md" 2>/dev/null || stat -c '%i' "$PROJ/.claude/agents/architect.md")

  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  INO_AFTER=$(stat -f '%i' "$PROJ/.claude/agents/architect.md" 2>/dev/null || stat -c '%i' "$PROJ/.claude/agents/architect.md")

  [ "$INO_BEFORE" = "$INO_AFTER" ]
}
