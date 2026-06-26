#!/usr/bin/env bats

# install-symlinks.bats — FR-212d-updated.
#
# HISTORY: this file pinned the native TS per-project symlink layer of `igris
# install` (.claude/{agents,skills} symlinks + .igris_version). FR-212d Phase 2
# DELETED that layer (and the `--legacy-per-project` flag): `igris install` is
# register-only — skills/agents project GLOBALLY at `igris init` (skills via the
# `skills` CLI delegate; agents via the global agent compiler). So this file now
# pins the INVERSE: register-only install materializes NO per-project layer. The
# TD-267 CLAUDE.md boot-pointer guard (engine-independent) is retained.

load _helpers.bash

# Stage a brain WITH core/{agents,skills} so a (former) symlink layer WOULD have
# had sources to link — proving register-only does NOT link, not that there is
# nothing to link.
stage_brain_with_core() {
  stage_brain  # writes canonical-settings.json + memory/

  mkdir -p "$IGRIS_BRAIN_DIR/core/agents"
  printf '# architect\n' > "$IGRIS_BRAIN_DIR/core/agents/architect.md"
  printf '# forger\n'    > "$IGRIS_BRAIN_DIR/core/agents/forger.md"
  printf 'agents: []\n'  > "$IGRIS_BRAIN_DIR/core/agents/manifest.yaml"

  mkdir -p "$IGRIS_BRAIN_DIR/core/skills/hunt"
  printf '# hunt skill\n' > "$IGRIS_BRAIN_DIR/core/skills/hunt/SKILL.md"
  mkdir -p "$IGRIS_BRAIN_DIR/core/skills/scan"
  printf '# scan skill\n' > "$IGRIS_BRAIN_DIR/core/skills/scan/SKILL.md"
}

setup() {
  stage_brain_with_core
  export IGRIS_KEEP_BAK=0
}

@test "register-only install creates NO per-project .claude/{agents,skills} symlinks (FR-212d)" {
  PROJ="$(stage_project regonly)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  # The per-project symlink layer was deleted — surfaces project globally.
  [ ! -e "$PROJ/.claude/agents" ]
  [ ! -e "$PROJ/.claude/skills" ]
}

@test "register-only install writes NO .igris_version marker (FR-212d)" {
  PROJ="$(stage_project noversion)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  # The .igris_version writer + the per-project marker were retired.
  [ ! -f "$PROJ/.igris_version" ]
}

@test "install writes NO project CLAUDE.md (FR-191 render retired; TD-267 zero-config)" {
  PROJ="$(stage_project claudemd)"
  [ ! -f "$PROJ/CLAUDE.md" ]

  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]

  # install is zero-config: it writes NO identity file (FR-191 retired the render
  # + its .tmpl; TD-267 made CLAUDE.md a static boot-pointer).
  [ ! -f "$PROJ/CLAUDE.md" ]
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
