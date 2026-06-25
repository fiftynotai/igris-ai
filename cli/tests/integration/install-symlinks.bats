#!/usr/bin/env bats

# install-symlinks.bats — integration tests for the native TS symlink layer
# of `igris install` (M2.6/M2.10). Asserts that .claude/{agents,skills}
# symlinks land correctly when the CLI fully owns the symlink layer (no shell
# script invoked). FR-187 retired the .claude/rules/ symlink layer (the
# universal rule moved to core/os/standards.md) — install creates no rules link.
#
# Brain core staged in $IGRIS_BRAIN_DIR via stage_brain_with_core helper
# below — minimal but realistic: a couple of agents, the universal rule, two
# skill dirs. (No CLAUDE.md template — FR-191 retired the render; TD-267 made
# CLAUDE.md a static boot-pointer that install never regenerates.)

load _helpers.bash

# Stage a brain that includes core/{agents,skills} so the native symlink
# layer can find sources to link. Matches stage_brain's tmp layout but with
# extras. (No core/rules/ — FR-187 retired the rules symlink layer.)
stage_brain_with_core() {
  stage_brain  # writes canonical-settings.json + memory/

  # Agents
  mkdir -p "$IGRIS_BRAIN_DIR/core/agents"
  printf '# architect\n' > "$IGRIS_BRAIN_DIR/core/agents/architect.md"
  printf '# forger\n'    > "$IGRIS_BRAIN_DIR/core/agents/forger.md"
  printf 'agents: []\n'  > "$IGRIS_BRAIN_DIR/core/agents/manifest.yaml"

  # Skills (each is a directory)
  mkdir -p "$IGRIS_BRAIN_DIR/core/skills/hunt"
  printf '# hunt skill\n' > "$IGRIS_BRAIN_DIR/core/skills/hunt/SKILL.md"
  mkdir -p "$IGRIS_BRAIN_DIR/core/skills/scan"
  printf '# scan skill\n' > "$IGRIS_BRAIN_DIR/core/skills/scan/SKILL.md"

  # FR-191 retired the CLAUDE.md render + its .tmpl; TD-267 made CLAUDE.md a
  # static boot-pointer. No template is staged — install writes no CLAUDE.md.
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

@test "install writes NO project CLAUDE.md (FR-191 render retired; TD-267 zero-config)" {
  PROJ="$(stage_project claudemd)"
  # Project has no pre-existing CLAUDE.md.
  [ ! -f "$PROJ/CLAUDE.md" ]

  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]

  # install is zero-config: it writes NO identity file. The CLAUDE.md render
  # machinery + its .tmpl were retired (FR-191) and the file carries no
  # enumeration (TD-267) — install must not regenerate one.
  [ ! -f "$PROJ/CLAUDE.md" ]
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

# TD-267: the repo-root CLAUDE.md is a static boot-pointer. It MUST carry no
# identity assertion and no hardcoded skill/agent/path enumeration — those drift
# (the pre-TD-267 file already listed renamed/deleted skills). This guard fires
# if a future contributor regrows enumeration into CLAUDE.md (the #254 regrowth
# class, now prevented for humans, not just hooks). Lightweight grep, not a
# standalone validator (S-sized; MAINTAINING.md holds the durable contract).
@test "repo CLAUDE.md is a boot-pointer — no identity assertion, no enumeration (TD-267)" {
  REPO_ROOT="$(cd "$CLI_DIST/../.." && pwd)"
  CLAUDE_MD="$REPO_ROOT/CLAUDE.md"
  [ -f "$CLAUDE_MD" ]

  # No identity assertion.
  run grep -iE 'You ARE Igris' "$CLAUDE_MD"
  [ "$status" -ne 0 ]

  # No enumeration headings (skill list / agent list / key-paths table).
  run grep -iE '## Available Skills|## Available Agents|## Key Paths' "$CLAUDE_MD"
  [ "$status" -ne 0 ]

  # No skill-roster enumeration: for every skill in core/skills/* OTHER than the
  # single allowed `/boot` reference, the `/<skill>` token must be absent. This
  # is roster-driven (self-updating) and path-safe (it matches only real skill
  # names, not `/core` / `/os` path segments in the `~/.igris/...` pointer).
  for skill_dir in "$REPO_ROOT"/core/skills/*/; do
    skill="$(basename "$skill_dir")"
    [ "$skill" = "boot" ] && continue
    run grep -F "/$skill" "$CLAUDE_MD"
    [ "$status" -ne 0 ]
  done
}
