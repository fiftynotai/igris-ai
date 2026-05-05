#!/usr/bin/env bats

# install.bats — integration tests for `igris install`, sandboxed via
# IGRIS_BRAIN_DIR. The shell-script symlink layer is bypassed by relying on
# the CLI's `--no-hooks` mode + manual settings.json staging, OR by calling
# `node` with skipSymlinkLayer flag baked into the test environment.
#
# Phase 1 contract: install owns the materialized layer, delegates symlink
# layer to scripts/igris_install.sh. The bats harness here uses an env var
# IGRIS_TEST_SKIP_SYMLINK=1 hack: we instead set IGRIS_BRAIN_DIR + run the
# CLI directly, which DOES try to invoke the shell. To keep tests hermetic,
# we stub the shell script via a shim on PATH.

load _helpers.bash

setup() {
  stage_brain
  # Shim: when CLI looks up scripts/igris_install.sh, give it a no-op script.
  # We do this by manufacturing a `repoRoot` containing a stub script.
  STUB_REPO="$BATS_TEST_TMPDIR/stub-repo"
  mkdir -p "$STUB_REPO/scripts"
  cat > "$STUB_REPO/scripts/igris_install.sh" <<'EOF'
#!/bin/bash
# Stub: the CLI invokes this for the symlink layer; for bats we no-op.
echo "stub: igris_install.sh $*" >&2
exit 0
EOF
  chmod +x "$STUB_REPO/scripts/igris_install.sh"
  cd "$STUB_REPO"
  export IGRIS_KEEP_BAK=0
}

@test "vanilla install creates registry row, features file, hooks block" {
  PROJ="$(stage_project myproj)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  [ -f "$PROJ/.claude/settings.json" ]
  # Hooks SessionEnd present
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(d['hooks']['SessionEnd'][0]['hooks'][0]['command'])"
  [ "$status" -eq 0 ]
  [ "$output" = "\$HOME/.igris/core/hooks/shared/session_end.sh" ]
  # Registry row written
  [ -f "$IGRIS_BRAIN_DIR/projects/myproj/installed_features.json" ]
}

@test "default install installs hooks (regression test for v6 silent-failure / TD-100)" {
  PROJ="$(stage_project canary)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(bool(d.get('hooks',{}).get('SessionEnd')))"
  [ "$status" -eq 0 ]
  [ "$output" = "True" ]
}

@test "--no-hooks omits hooks block but installs everything else" {
  PROJ="$(stage_project nohooks)"
  run $CLI_BIN install --no-hooks "$PROJ"
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

@test "install preserves a custom permissions.allow array byte-for-byte" {
  PROJ="$(stage_project withperms)"
  cat > "$PROJ/.claude/settings.json" <<EOF
{
  "permissions": {
    "allow": ["Bash(git diff:*)", "Bash(git log:*)"]
  }
}
EOF
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(','.join(d['permissions']['allow']))"
  [ "$status" -eq 0 ]
  [ "$output" = "Bash(git diff:*),Bash(git log:*)" ]
}

@test "install on a project with includeGitInstructions:false preserves that key" {
  PROJ="$(stage_project bri058)"
  cat > "$PROJ/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(d['includeGitInstructions'])"
  [ "$status" -eq 0 ]
  [ "$output" = "False" ]
}

@test "re-install over existing is idempotent (no settings.json drift)" {
  PROJ="$(stage_project idem)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  cp "$PROJ/.claude/settings.json" "$BATS_TEST_TMPDIR/first.json"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  run diff -q "$BATS_TEST_TMPDIR/first.json" "$PROJ/.claude/settings.json"
  [ "$status" -eq 0 ]
}
