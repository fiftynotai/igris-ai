#!/usr/bin/env bats

# refresh.bats — integration tests for `igris refresh`. Hermetic via
# IGRIS_BRAIN_DIR + --from-source. Uses a pre-seeded brain (one init,
# then one refresh) to mirror the real flow.

load _helpers.bash

setup() {
  export IGRIS_BRAIN_DIR="$BATS_TEST_TMPDIR/igris-brain"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  SOURCE_REPO="$BATS_TEST_TMPDIR/source-repo"
  stage_source_repo "$SOURCE_REPO"
  # Pre-seed brain via init.
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
}

stage_source_repo() {
  local root="$1"
  mkdir -p "$root/core/agents" "$root/core/rules" "$root/core/skills/demo" \
           "$root/core/hooks" "$root/core/scripts"
  printf '# soul v1\n' > "$root/core/SOUL.md"
  printf 'agents: []\n' > "$root/core/agents/manifest.yaml"
  printf '# u\n' > "$root/core/rules/00-igris-universal.md"
  printf '# s\n' > "$root/core/skills/demo/SKILL.md"
  printf '{"hooks":{}}\n' > "$root/core/hooks/canonical-settings.json"
  printf '#!/bin/sh\n' > "$root/core/scripts/verify_mirror.sh"
  chmod +x "$root/core/scripts/verify_mirror.sh"
}

@test "refresh --from-source replaces core/ in place" {
  printf '# soul v2\n' > "$SOURCE_REPO/core/SOUL.md"
  run $CLI_BIN refresh --from-source "$SOURCE_REPO" --no-propagate
  [ "$status" -eq 0 ]
  run cat "$IGRIS_BRAIN_DIR/core/SOUL.md"
  [ "$output" = "# soul v2" ]
}

@test "refresh creates a core.bak.<ts>/ next to core/" {
  run $CLI_BIN refresh --from-source "$SOURCE_REPO" --no-propagate
  [ "$status" -eq 0 ]
  bak_count=$(find "$IGRIS_BRAIN_DIR" -maxdepth 1 -name 'core.bak.*' | wc -l | tr -d ' ')
  [ "$bak_count" -ge 1 ]
}

@test "refresh --dry-run writes nothing" {
  SHA_BEFORE=$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')
  run $CLI_BIN refresh --from-source "$SOURCE_REPO" --no-propagate --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run plan:"* ]]
  SHA_AFTER=$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')
  [ "$SHA_BEFORE" = "$SHA_AFTER" ]
}

@test "refresh on missing .install-source.json errors" {
  rm -f "$IGRIS_BRAIN_DIR/.install-source.json"
  run $CLI_BIN refresh --from-source "$SOURCE_REPO" --no-propagate
  [ "$status" -eq 1 ]
  [[ "$output" == *"No .install-source.json"* ]]
}

@test "refresh updates .install-source.json fetched_at on success" {
  ORIG_FETCHED=$(python3 -c "import json; print(json.load(open('$IGRIS_BRAIN_DIR/.install-source.json'))['fetched_at'])")
  sleep 1
  run $CLI_BIN refresh --from-source "$SOURCE_REPO" --no-propagate
  [ "$status" -eq 0 ]
  NEW_FETCHED=$(python3 -c "import json; print(json.load(open('$IGRIS_BRAIN_DIR/.install-source.json'))['fetched_at'])")
  [ "$ORIG_FETCHED" != "$NEW_FETCHED" ]
}
