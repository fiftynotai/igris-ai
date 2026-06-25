#!/usr/bin/env bats

# init.bats — integration tests for `igris init`. Hermetic via
# IGRIS_BRAIN_DIR + --from-source. Each test stages its own source
# repo + fresh empty brain dir.

load _helpers.bash

setup() {
  # Each test gets its own brain root + source repo + temp HOME.
  # HOME override gives cli-detect a clean tree; we DON'T override
  # PATH because bats itself needs basic shell utilities (mkdir, tar,
  # etc.) on PATH. The empty-bin trick the unit tests use isn't
  # needed here — at the bats layer cli-detect won't find any of the
  # 4 supported CLIs in our HOME-overriden config dir, so the
  # detection set is empty regardless.
  export IGRIS_BRAIN_DIR="$BATS_TEST_TMPDIR/igris-brain"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  SOURCE_REPO="$BATS_TEST_TMPDIR/source-repo"
  stage_source_repo "$SOURCE_REPO"
}

stage_source_repo() {
  local root="$1"
  mkdir -p "$root/core/agents" "$root/core/skills/demo" \
           "$root/core/prompts" "$root/core/hooks" "$root/core/scripts"
  printf '# soul (bats)\n' > "$root/core/SOUL.md"
  printf '{ "version": "fixture" }\n' > "$root/core/igris_tree.json"
  printf 'agents: []\n' > "$root/core/agents/manifest.yaml"
  printf '# demo skill\n' > "$root/core/skills/demo/SKILL.md"
  printf '{"hooks":{}}\n' > "$root/core/hooks/canonical-settings.json"
  printf '#!/bin/sh\necho noop\n' > "$root/core/scripts/verify_mirror.sh"
  chmod +x "$root/core/scripts/verify_mirror.sh"
  printf '# igris_os\n' > "$root/core/prompts/igris_os.md"
}

@test "init --from-source creates the brain dir tree and core/ contents" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  [ -d "$IGRIS_BRAIN_DIR/memory" ]
  [ -d "$IGRIS_BRAIN_DIR/projects" ]
  [ -d "$IGRIS_BRAIN_DIR/logs" ]
  [ -d "$IGRIS_BRAIN_DIR/.cache" ]
  [ -f "$IGRIS_BRAIN_DIR/core/SOUL.md" ]
  [ -f "$IGRIS_BRAIN_DIR/core/skills/demo/SKILL.md" ]
  [ -f "$IGRIS_BRAIN_DIR/USER.md" ]
  [ -f "$IGRIS_BRAIN_DIR/config.json" ]
  [ -f "$IGRIS_BRAIN_DIR/.install-source.json" ]
}

@test "init refuses to overwrite existing v7 install without --upgrade" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 1 ]
  [[ "$output" == *"--upgrade"* ]]
}

@test "init --upgrade preserves USER.md and config.json byte-for-byte" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]

  # User mutates state files.
  printf 'my custom user notes\n' > "$IGRIS_BRAIN_DIR/USER.md"
  USER_BEFORE_SHA=$(shasum -a 256 "$IGRIS_BRAIN_DIR/USER.md" | awk '{print $1}')
  CFG_BEFORE_SHA=$(shasum -a 256 "$IGRIS_BRAIN_DIR/config.json" | awk '{print $1}')

  # Mutate the source between init and upgrade.
  printf '# soul (bats v2)\n' > "$SOURCE_REPO/core/SOUL.md"

  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  [ "$status" -eq 0 ]

  USER_AFTER_SHA=$(shasum -a 256 "$IGRIS_BRAIN_DIR/USER.md" | awk '{print $1}')
  CFG_AFTER_SHA=$(shasum -a 256 "$IGRIS_BRAIN_DIR/config.json" | awk '{print $1}')
  [ "$USER_BEFORE_SHA" = "$USER_AFTER_SHA" ]
  [ "$CFG_BEFORE_SHA" = "$CFG_AFTER_SHA" ]

  # And core itself was upgraded.
  run cat "$IGRIS_BRAIN_DIR/core/SOUL.md"
  [ "$output" = "# soul (bats v2)" ]
}

@test "init --upgrade on empty brain errors with actionable message" {
  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  [ "$status" -eq 1 ]
  [[ "$output" == *"no existing install"* ]]
}

@test "init --cli-bridge=none keeps cli_targets empty" {
  run $CLI_BIN init --from-source "$SOURCE_REPO" --cli-bridge none
  [ "$status" -eq 0 ]
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/config.json')); print(len(d['cli_targets']))"
  [ "$status" -eq 0 ]
  [ "$output" = "0" ]
}

@test "init --skip-remote sets remote_brain to null in config.json" {
  run $CLI_BIN init --from-source "$SOURCE_REPO" --skip-remote
  [ "$status" -eq 0 ]
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/config.json')); print(d['remote_brain'])"
  [ "$status" -eq 0 ]
  [ "$output" = "None" ]
}

@test "init --dry-run prints plan and writes nothing" {
  run $CLI_BIN init --from-source "$SOURCE_REPO" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run plan:"* ]]
  [[ "$output" == *"No filesystem writes"* ]]
  # Brain dir should NOT have core/ or templates.
  [ ! -f "$IGRIS_BRAIN_DIR/core/SOUL.md" ]
  [ ! -f "$IGRIS_BRAIN_DIR/USER.md" ]
}

@test "init writes .install-source.json with source=from-source" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/.install-source.json')); print(d['source'])"
  [ "$status" -eq 0 ]
  [ "$output" = "from-source" ]
}

@test "init registers igris-brain MCP in ~/.claude.json (TD-168)" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  # HOME is overridden to $BATS_TEST_TMPDIR/home in setup(), so
  # ~/.claude.json lands there.
  [ -f "$HOME/.claude.json" ]
  run python3 -c "import json; d=json.load(open('$HOME/.claude.json')); e=d['mcpServers']['igris-brain']; print(e['type'], e['command'])"
  [ "$status" -eq 0 ]
  [ "$output" = "stdio node" ]
}

@test "init does NOT corrupt a malformed ~/.claude.json (non-fatal)" {
  # Pre-write a malformed ~/.claude.json. init must complete (exit 0,
  # non-fatal MCP registration) and leave the broken file byte-unchanged.
  printf '{ broken json,,, ' > "$HOME/.claude.json"
  BEFORE_SHA=$(shasum -a 256 "$HOME/.claude.json" | awk '{print $1}')

  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]

  AFTER_SHA=$(shasum -a 256 "$HOME/.claude.json" | awk '{print $1}')
  [ "$BEFORE_SHA" = "$AFTER_SHA" ]
  # No backup or tmp litter from the refused write.
  [ ! -f "$HOME/.claude.json.igris.bak" ]
}
