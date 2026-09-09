#!/usr/bin/env bats

# refresh.bats — integration tests for `igris refresh`. Hermetic via
# IGRIS_BRAIN_DIR + --from-source. Uses a pre-seeded brain (one init,
# then one refresh) to mirror the real flow.

load _helpers.bash

setup() {
  export IGRIS_BRAIN_DIR="$BATS_TEST_TMPDIR/igris-brain"
  fence_home  # TD-456: HOME=$BATS_TEST_TMPDIR/home, asserted (the pre-seed init writes under $HOME)
  SOURCE_REPO="$BATS_TEST_TMPDIR/source-repo"
  stage_source_repo "$SOURCE_REPO"
  # Pre-seed brain via init.
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
}

stage_source_repo() {
  local root="$1"
  mkdir -p "$root/core/agents" "$root/core/skills/demo" \
           "$root/core/hooks" "$root/core/scripts"
  printf '# soul v1\n' > "$root/core/SOUL.md"
  printf 'agents: []\n' > "$root/core/agents/manifest.yaml"
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

# --- BR-103: `refresh` shares the swap helpers with `init --upgrade` ----------

@test "R1 (BR-103): refresh preserves the runtime-only extras — manifest regenerated from the source root, component-manifest carried, unlisted extra not carried" {
  printf '{ "harnesses": {}, "v": 1 }\n' > "$SOURCE_REPO/harness-manifest.json"
  mkdir -p "$IGRIS_BRAIN_DIR/core/docs"
  printf '# component manifest (runtime-only)\n' > "$IGRIS_BRAIN_DIR/core/docs/component-manifest.md"
  printf 'stale\n' > "$IGRIS_BRAIN_DIR/core/stray.md"
  run $CLI_BIN refresh --from-source "$SOURCE_REPO" --no-propagate --verbose
  echo "$output"
  [ "$status" -eq 0 ]
  cmp "$SOURCE_REPO/harness-manifest.json" "$IGRIS_BRAIN_DIR/core/harness-manifest.json"
  run cat "$IGRIS_BRAIN_DIR/core/docs/component-manifest.md"
  [ "$output" = "# component manifest (runtime-only)" ]
  [ ! -e "$IGRIS_BRAIN_DIR/core/stray.md" ]
}

@test "R2 (BR-103): refresh REFUSES on core.new.* staging residue; --wipe-orphans proceeds" {
  mkdir "$IGRIS_BRAIN_DIR/core.new.4242"
  W_IS="$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')"
  printf '# soul v2\n' > "$SOURCE_REPO/core/SOUL.md"
  run $CLI_BIN refresh --from-source "$SOURCE_REPO" --no-propagate
  echo "$output"
  [ "$status" -ne 0 ]
  grep -q 'core.new.4242' <<<"$output"
  [ "$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')" = "$W_IS" ]
  run cat "$IGRIS_BRAIN_DIR/core/SOUL.md"
  [ "$output" = "# soul v1" ]
  run $CLI_BIN refresh --from-source "$SOURCE_REPO" --no-propagate --wipe-orphans
  [ "$status" -eq 0 ]
  [ ! -d "$IGRIS_BRAIN_DIR/core.new.4242" ]
  run cat "$IGRIS_BRAIN_DIR/core/SOUL.md"
  [ "$output" = "# soul v2" ]
}

# ---- TD-301 (2026-09-08): refresh BACKFILLS ref_commit_sha ------------------
#
# The upgrade answer for a 7.3.1 record: a main/branch record gains the field
# on the next refresh; a release/tag record never gains it and never needs it.

@test "TD-301 refresh: a --channel main refresh BACKFILLS ref_commit_sha onto a v1 record" {
  STUB_SHA="b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f80"
  # A pre-7.3.2 record: schema 1, main channel, NO ref_commit_sha.
  printf '{\n  "schema_version": 1,\n  "channel": "main",\n  "ref": "main",\n  "fetched_at": "2026-01-01T00:00:00Z",\n  "content_sha256": "d1aa7cae3f92b6045e8c17da29bf60e34c5178ab90de2f4361a7c8b5e0d93f26",\n  "source": "github",\n  "source_path": null\n}\n' > "$IGRIS_BRAIN_DIR/.install-source.json"
  TARBALL="$(stage_fixture_tarball)"
  COMMITS_FILE="$BATS_TEST_TMPDIR/https-commits"
  NODE_OPTIONS="--require $GITHUB_STUB_PRELOAD" IGRIS_TEST_HTTPS_MODE=stub \
    IGRIS_TEST_HTTPS_COMMITS_COUNT_FILE="$COMMITS_FILE" \
    IGRIS_TEST_GITHUB_STUB_COMMIT_SHA="$STUB_SHA" \
    IGRIS_TARBALL_FILE="$TARBALL" \
    run $CLI_BIN refresh --channel main --no-propagate
  echo "$output"
  [ "$status" -eq 0 ]
  run python3 -c "import json;d=json.load(open('$IGRIS_BRAIN_DIR/.install-source.json'));print(d['schema_version'],d['channel'],d.get('ref_commit_sha'))"
  [ "$output" = "2 main $STUB_SHA" ]
  [ "$(cat "$COMMITS_FILE")" -ge 1 ]
}
