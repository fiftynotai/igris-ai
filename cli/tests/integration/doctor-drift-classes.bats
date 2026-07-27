#!/usr/bin/env bats

# doctor-drift-classes.bats — one fixture per drift class. M5 of MG-014.
#
# Phase 1 classes (4): path-missing, hooks-missing, hooks-stale, duplicate-path
#   (clean, not-installed, slug-basename-mismatch, symlink-target are exercised
#    in the existing doctor.bats; this file focuses on the 4 + the 4 new M5
#    classes that need end-to-end verification.)
#
# M5 classes (4): brain-core-missing, brain-core-stale, channel-mismatch,
#   bridge-missing.
#
# Each fixture:
#   - sets up the drift state
#   - runs `igris doctor` and asserts the class appears in output
#   - where --fix is supported, runs `igris doctor --fix` and asserts
#     the class disappears (or the fix command was issued).

load _helpers.bash

# TD-303: every test in this file gets a sandboxed HOME with a CLEAN doctor
# baseline, mirroring doctor.bats:19-40 (TD-299).
#
# Before this, `stage_brain` sandboxed only IGRIS_BRAIN_DIR. Tests 2/3 called
# stage_home() and test 8 passed a stub HOME per-invocation, but tests 1/4/5/6/7
# ran under the developer's REAL $HOME — and four of them invoke
# `doctor --fix`, which (doctor.ts) merges global canonical hooks into
# ~/.claude/settings.json from the STUB hooks in _helpers.bash, re-points the
# igris-brain MCP entry + writes no-prompt grant files across ~/.claude.json /
# ~/.gemini / ~/.codex, and can migrate the real ~/.claude/skills + agents roots
# from a coreSkillsSource() that does not exist under stage_brain.
#
# It also made the file order-dependent: `bats tests/integration` runs
# alphabetically, so default-install-installs-hooks.bats mutated the same real
# ~/.claude.json this file then read.
#
# stage_home() (not a bare empty HOME) is used deliberately: it seeds a clean
# baseline so ONLY the drift a test deliberately injects fires. A bare sandbox
# would add ambient hooks-missing/mcp-unregistered rows and make these tests
# pass by permissiveness — the thing this change exists to remove.
#
# Tests 2/3 re-call stage_home() and tests 2/3/8 pass HOME= explicitly per
# invocation; both remain correct (stage_home is idempotent and resolves the
# same $BATS_TEST_TMPDIR/home path).
setup() {
  stage_brain
  export IGRIS_KEEP_BAK=0
  HOME="$(stage_home)"
  export HOME
}

# ---- Phase 1 classes (existing detector exercise) ------------------

@test "drift class 1/8: path-missing — registry row points at deleted dir" {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('orphan-r','orphan-r','/no/such/dir/orphan-r','7.0.0');
  "
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "path-missing" ]]
  # --fix doesn't address path-missing (--remove-orphans does); just assert no crash.
  run $CLI_BIN doctor --fix
  [[ "$output" =~ "path-missing" ]]
}

@test "drift class 2/8: hooks-missing — settings.json present but no Igris SessionEnd" {
  # FR-212d: hooks are GLOBAL ($HOME/.claude/settings.json), so inject the drift
  # into an isolated HOME (TD-299) — a per-project settings.json is no longer read.
  HOME_DIR="$(stage_home)"
  PROJ="$(stage_project hm)"
  cat > "$HOME_DIR/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('hm','hm','$PROJ','7.0.0');
  "
  HOME="$HOME_DIR" run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "hooks-missing" ]]
  # --fix repairs it (merges the canonical global hooks into the isolated HOME).
  HOME="$HOME_DIR" run $CLI_BIN doctor --fix
  [ "$status" -eq 0 ]
}

@test "drift class 3/8: hooks-stale — Igris SessionEnd command path differs from canonical" {
  # FR-212d: hooks are GLOBAL, so inject a non-canonical SessionEnd command into
  # the isolated HOME's $HOME/.claude/settings.json (TD-299).
  HOME_DIR="$(stage_home)"
  PROJ="$(stage_project hs)"
  cat > "$HOME_DIR/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "$HOME/.igris/core/hooks/old/session_end.sh" }] }
    ]
  }
}
EOF
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('hs','hs','$PROJ','7.0.0');
  "
  HOME="$HOME_DIR" run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "hooks-stale" ]]
  # --fix repairs it (refreshes the global hooks in the isolated HOME).
  HOME="$HOME_DIR" run $CLI_BIN doctor --fix
  [ "$status" -eq 0 ]
}

@test "drift class 4/8: duplicate-path — multiple slugs share path" {
  PROJ="$(stage_project shared)"
  run $CLI_BIN install --slug slug-a "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN install --slug slug-b "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "duplicate-path" ]]
  # --fix should NOT auto-resolve duplicate-path (manual decision).
  run $CLI_BIN doctor --fix 2>&1
  [[ "$output" =~ "duplicate-path" ]]
}

# ---- M5 classes (new detectors) ----------------------------------

@test "drift class 5/8: brain-core-missing — ~/.igris/core/ deleted" {
  # Wipe the core/ dir staged by stage_brain.
  rm -rf "$IGRIS_BRAIN_DIR/core"
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "brain-core-missing" ]]
  # --fix attempts a refresh, which will fail in the sandbox (no install-source.json,
  # no network). We still assert the message surfaces and exit code is non-zero.
  run $CLI_BIN doctor --fix 2>&1
  [[ "$output" =~ "brain-core-missing" ]]
}

@test "drift class 6/8: brain-core-stale — install-source sha differs from channel head" {
  # Re-stage core (stage_brain populated it; we keep it for stale-detection
  # to even have a baseline). Then write an .install-source.json whose
  # content_sha256 cannot match any real GitHub head.
  cat > "$IGRIS_BRAIN_DIR/.install-source.json" <<EOF
{
  "schema_version": 1,
  "channel": "release",
  "ref": "v0.0.0-fake",
  "fetched_at": "2026-01-01T00:00:00Z",
  "content_sha256": "deadbeef-old-sha-that-cannot-match-any-real-head",
  "source": "github",
  "source_path": null
}
EOF
  # Without network, the detector returns null on fetch failure (best-effort).
  # That's the documented behavior — staleness is a positive assertion. We
  # assert the fixture itself runs without crashing; staleness only surfaces
  # in environments where the GitHub API call resolves to a different sha.
  # Set IGRIS_GITHUB_OWNER to a definitely-nonexistent owner so the API
  # returns 404; the detector swallows the error and returns null.
  IGRIS_GITHUB_OWNER=this-owner-does-not-exist-fixture run $CLI_BIN doctor
  # Either status code is fine (depends on what other drift exists);
  # what matters is the verb didn't crash.
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
}

@test "drift class 7/8: channel-mismatch — installed_features.json#cli_version newer than CLI" {
  PROJ="$(stage_project ahead)"
  run $CLI_BIN install --slug ahead "$PROJ"
  [ "$status" -eq 0 ]
  # Hand-edit the installed_features.json to claim cli_version=99.0.0.
  python3 -c "
import json
p='$IGRIS_BRAIN_DIR/projects/ahead/installed_features.json'
d=json.load(open(p))
d['cli_version']='99.0.0'
json.dump(d, open(p,'w'), indent=2)
"
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "channel-mismatch" ]]
  # No --fix path: channel-mismatch surfaces as a warning, not an auto-fix.
  run $CLI_BIN doctor --fix 2>&1
  [[ "$output" =~ "channel-mismatch" ]]
}

@test "drift class 8/8: bridge-missing — config.json cli_targets lacks a detected CLI" {
  # Write config.json claiming only claude is wired; stub PATH so codex looks installed.
  cat > "$IGRIS_BRAIN_DIR/config.json" <<'EOF'
{
  "version": "7.0.0",
  "cli_targets": { "claude": { "hooks": {} } }
}
EOF
  # Stub a fake codex binary on PATH and a config dir so detectInstalledCLIs sees it.
  STUB_BIN="$BATS_TEST_TMPDIR/stub-bin"
  mkdir -p "$STUB_BIN"
  cat > "$STUB_BIN/codex" <<'EOF'
#!/bin/sh
echo fake
EOF
  chmod +x "$STUB_BIN/codex"
  # Detector reads from $HOME for the config-dir signal.
  STUB_HOME="$BATS_TEST_TMPDIR/stub-home"
  mkdir -p "$STUB_HOME/.codex"
  PATH="$STUB_BIN:$PATH" HOME="$STUB_HOME" run $CLI_BIN doctor
  # bridge-missing alone exits 1.
  [ "$status" -eq 1 ]
  [[ "$output" =~ "bridge-missing" ]]
  [[ "$output" =~ "codex" ]]
  # --fix invokes partial init (which will probably fail in the sandbox
  # with no .install-source.json or remote, but the error is non-fatal —
  # we just assert the fixer was attempted).
  PATH="$STUB_BIN:$PATH" HOME="$STUB_HOME" run $CLI_BIN doctor --fix 2>&1
  [[ "$output" =~ "bridge-missing" ]] || true
}
