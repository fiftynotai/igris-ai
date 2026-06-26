#!/usr/bin/env bats

# install.bats — integration tests for `igris install`, sandboxed via
# IGRIS_BRAIN_DIR. Phase 2 (M2): the CLI owns the entire install pipeline
# natively in TS — no shell-script symlink layer to stub. Tests stage a
# minimal brain core in tmp and assert the verb's outputs (settings.json,
# CLAUDE.md, .igris_version, registry rows, installed_features.json).
#
# FR-212c: the DEFAULT install is register-only (registry row + features file;
# NO per-project settings.json). The per-project hooks layer is LEGACY, pinned
# via `--legacy-per-project`. Tests that assert the per-project settings.json
# carry the flag; the register-only default is asserted directly below.

load _helpers.bash

setup() {
  stage_brain
  export IGRIS_KEEP_BAK=0
}

@test "register-only default: registry row + features file, NO settings.json (FR-212c)" {
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

@test "legacy-per-project install creates registry row, features file, hooks block" {
  PROJ="$(stage_project myproj)"
  run $CLI_BIN install --legacy-per-project "$PROJ"
  [ "$status" -eq 0 ]
  [ -f "$PROJ/.claude/settings.json" ]
  # Hooks SessionEnd present
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(d['hooks']['SessionEnd'][0]['hooks'][0]['command'])"
  [ "$status" -eq 0 ]
  [ "$output" = "\$HOME/.igris/core/hooks/shared/session_end.sh" ]
  # Registry row written
  [ -f "$IGRIS_BRAIN_DIR/projects/myproj/installed_features.json" ]
  # Schema v2
  run python3 -c "import json,sys; d=json.load(open('$IGRIS_BRAIN_DIR/projects/myproj/installed_features.json')); print(d['schema_version'])"
  [ "$status" -eq 0 ]
  [ "$output" = "2" ]
}

@test "legacy install installs hooks (regression test for v6 silent-failure / TD-100)" {
  PROJ="$(stage_project canary)"
  run $CLI_BIN install --legacy-per-project "$PROJ"
  [ "$status" -eq 0 ]
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(bool(d.get('hooks',{}).get('SessionEnd')))"
  [ "$status" -eq 0 ]
  [ "$output" = "True" ]
}

@test "--no-hooks omits hooks block but installs everything else (legacy)" {
  PROJ="$(stage_project nohooks)"
  run $CLI_BIN install --legacy-per-project --no-hooks "$PROJ"
  [ "$status" -eq 0 ]
  # settings.json should NOT exist (we don't create it without hooks)
  [ ! -f "$PROJ/.claude/settings.json" ]
  # But features file does
  [ -f "$IGRIS_BRAIN_DIR/projects/nohooks/installed_features.json" ]
  # And hooks_version is null
  run python3 -c "import json,sys; d=json.load(open('$IGRIS_BRAIN_DIR/projects/nohooks/installed_features.json')); print(d['hooks_version'])"
  [ "$status" -eq 0 ]
  [ "$output" = "None" ]
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

@test "legacy install preserves a custom permissions.allow array byte-for-byte" {
  PROJ="$(stage_project withperms)"
  cat > "$PROJ/.claude/settings.json" <<EOF
{
  "permissions": {
    "allow": ["Bash(git diff:*)", "Bash(git log:*)"]
  }
}
EOF
  run $CLI_BIN install --legacy-per-project "$PROJ"
  [ "$status" -eq 0 ]
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(','.join(d['permissions']['allow']))"
  [ "$status" -eq 0 ]
  [ "$output" = "Bash(git diff:*),Bash(git log:*)" ]
}

@test "legacy install on a project with includeGitInstructions:false preserves that key" {
  PROJ="$(stage_project bri058)"
  cat > "$PROJ/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  run $CLI_BIN install --legacy-per-project "$PROJ"
  [ "$status" -eq 0 ]
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(d['includeGitInstructions'])"
  [ "$status" -eq 0 ]
  [ "$output" = "False" ]
}

@test "re-install (legacy) over existing is idempotent (no settings.json drift)" {
  PROJ="$(stage_project idem)"
  run $CLI_BIN install --legacy-per-project "$PROJ"
  [ "$status" -eq 0 ]
  cp "$PROJ/.claude/settings.json" "$BATS_TEST_TMPDIR/first.json"
  run $CLI_BIN install --legacy-per-project "$PROJ"
  [ "$status" -eq 0 ]
  run diff -q "$BATS_TEST_TMPDIR/first.json" "$PROJ/.claude/settings.json"
  [ "$status" -eq 0 ]
}
