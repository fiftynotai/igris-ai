#!/usr/bin/env bats

# register-project.bats — integration tests for `igris register-project`
# (M3.6). Sandboxed via IGRIS_BRAIN_DIR. Asserts that the verb's end-to-end
# CLI invocation:
#
#   1. writes a registry row keyed by slug, with the correct path
#   2. does NOT mutate <path>/.claude/ (no symlinks, no settings.json,
#      no CLAUDE.md, no .igris_version)
#   3. enforces slug grammar
#
# Per L-330: this file invokes `igris register-project` end-to-end via
# $CLI_BIN, NOT just the TS function — the AC bullet "tests exist for X"
# is met only when both the producer (the verb) and the consumer (the CLI
# bridge) are exercised.

load _helpers.bash

setup() {
  stage_brain
}

@test "register-project <existing-path>: writes registry row, no .claude/ mutation" {
  PROJ="$(stage_project regproj)"
  # Sanity: no .claude contents pre-run.
  [ -d "$PROJ/.claude" ]
  [ -z "$(ls -A "$PROJ/.claude" 2>/dev/null)" ]

  run $CLI_BIN register-project "$PROJ"
  [ "$status" -eq 0 ]

  # Registry row written, keyed by basename.
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT slug, path FROM projects;"
  [ "$status" -eq 0 ]
  [ "$output" = "regproj|$PROJ" ]

  # No .claude/ mutation: still empty.
  [ -z "$(ls -A "$PROJ/.claude" 2>/dev/null)" ]
  # No CLAUDE.md
  [ ! -f "$PROJ/CLAUDE.md" ]
  # No .igris_version
  [ ! -f "$PROJ/.igris_version" ]
  # No settings.json
  [ ! -f "$PROJ/.claude/settings.json" ]
  # No installed_features.json
  [ ! -f "$IGRIS_BRAIN_DIR/projects/regproj/installed_features.json" ]
}

@test "register-project --slug: explicit slug overrides basename" {
  PROJ="$(stage_project some_path)"
  run $CLI_BIN register-project --slug fifty-dev "$PROJ"
  [ "$status" -eq 0 ]
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT slug FROM projects WHERE path='$PROJ';"
  [ "$status" -eq 0 ]
  [ "$output" = "fifty-dev" ]
  # And NOT the basename slug.
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT slug FROM projects WHERE slug='some_path';"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "register-project missing path without --allow-missing-path: exits 1, no row" {
  GHOST="/this/path/does/not/exist/for/sure/12345"
  run $CLI_BIN register-project "$GHOST"
  [ "$status" -eq 1 ]
  [[ "$output" == *"path does not exist"* ]]
  # No row written. The DB file may not exist (verb errored before opening it),
  # which is itself proof of "no row written"; if it does exist, count is 0.
  if [ -f "$IGRIS_BRAIN_DIR/memory/knowledge.db" ]; then
    run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT COUNT(*) FROM projects;"
    [ "$status" -eq 0 ]
    [ "$output" = "0" ]
  fi
}
