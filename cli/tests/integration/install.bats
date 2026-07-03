#!/usr/bin/env bats

# install.bats — integration tests for `igris install`, sandboxed via
# IGRIS_BRAIN_DIR. FR-212d Phase 2: `igris install` is REGISTER-ONLY — it upserts
# the brain `projects` row + `installed_features.json` (+ the global igris-brain
# MCP registration). The per-project symlink layer, `.igris_version` marker, and
# per-project `settings.json` hooks merge (and the `--legacy-per-project` flag)
# were DELETED — every surface projects GLOBALLY at `igris init`. These tests pin
# the register-only contract + slug handling.

load _helpers.bash

setup() {
  stage_brain
  export IGRIS_KEEP_BAK=0
}

@test "register-only install: registry row + features file, NO settings.json (FR-212d)" {
  PROJ="$(stage_project myproj)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  # Register-only: no per-project settings.json.
  [ ! -f "$PROJ/.claude/settings.json" ]
  # Registry row + features file ARE written.
  [ -f "$IGRIS_BRAIN_DIR/projects/myproj/installed_features.json" ]
  # Schema v2
  run python3 -c "import json,sys; d=json.load(open('$IGRIS_BRAIN_DIR/projects/myproj/installed_features.json')); print(d['schema_version'])"
  [ "$status" -eq 0 ]
  [ "$output" = "2" ]
}

@test "--no-hooks is a no-op but still creates the registry row + features file (FR-212d)" {
  PROJ="$(stage_project nohooks)"
  run $CLI_BIN install --no-hooks "$PROJ"
  [ "$status" -eq 0 ]
  # No per-project settings.json (register-only, regardless of --no-hooks).
  [ ! -f "$PROJ/.claude/settings.json" ]
  # But features file does exist.
  [ -f "$IGRIS_BRAIN_DIR/projects/nohooks/installed_features.json" ]
  # And hooks_version is null (no hooks hashed under --no-hooks).
  run python3 -c "import json,sys; d=json.load(open('$IGRIS_BRAIN_DIR/projects/nohooks/installed_features.json')); print(d['hooks_version'])"
  [ "$status" -eq 0 ]
  [ "$output" = "None" ]
}

@test "install rejects the retired --legacy-per-project flag (FR-212d)" {
  PROJ="$(stage_project legacygone)"
  run $CLI_BIN install --legacy-per-project "$PROJ"
  # The flag was deleted — commander rejects the unknown option.
  [ "$status" -ne 0 ]
}

@test "--slug fifty-dev with basename fifty_dev produces registry row keyed fifty-dev (TD-100 fixture)" {
  PROJ="$(stage_project fifty_dev)"
  run $CLI_BIN install --slug fifty-dev "$PROJ"
  [ "$status" -eq 0 ]
  # Verify the registry row uses the explicit slug.
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT slug FROM projects WHERE slug='fifty-dev';"
  [ "$status" -eq 0 ]
  [ "$output" = "fifty-dev" ]
  # And NOT the basename slug
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT slug FROM projects WHERE slug='fifty_dev';"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "TD-112 (M2 reword): --slug fifty-dev with basename fifty_dev emits 'differs from directory name' note on stderr" {
  PROJ="$(stage_project fifty_dev)"
  # Capture stdout + stderr in one buffer.
  run bash -c "$CLI_BIN install --slug fifty-dev '$PROJ' 2>&1"
  [ "$status" -eq 0 ]
  [[ "$output" == *"differs from directory name"* ]]
  [[ "$output" == *"no action required"* ]]
  [[ "$output" == *"authoritative"* ]]
}

@test "--slug fifty-content-pipeline with basename content (TD-100 fixture)" {
  PROJ="$(stage_project content)"
  run $CLI_BIN install --slug fifty-content-pipeline "$PROJ"
  [ "$status" -eq 0 ]
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT slug FROM projects WHERE slug='fifty-content-pipeline';"
  [ "$status" -eq 0 ]
  [ "$output" = "fifty-content-pipeline" ]
}

@test "re-install with new --slug for same path leaves both registry rows" {
  PROJ="$(stage_project shared)"
  run $CLI_BIN install --slug old-slug "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN install --slug new-slug "$PROJ"
  [ "$status" -eq 0 ]
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT COUNT(*) FROM projects WHERE path='$PROJ';"
  [ "$status" -eq 0 ]
  [ "$output" = "2" ]
}

# FR-212d Phase 2: the legacy per-project settings.json tests (custom
# permissions.allow preservation, includeGitInstructions preservation, re-install
# settings.json idempotency) were DELETED — install no longer writes a
# per-project settings.json. The per-project hooks merge's no-clobber/idempotent
# contract is now exercised at the GLOBAL target by global-hooks.test.ts.

@test "re-install over existing is idempotent (no duplicate registry rows)" {
  PROJ="$(stage_project idem)"
  run $CLI_BIN install --slug idem "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN install --slug idem "$PROJ"
  [ "$status" -eq 0 ]
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT COUNT(*) FROM projects WHERE slug='idem';"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}
