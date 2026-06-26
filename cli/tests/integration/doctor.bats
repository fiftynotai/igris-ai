#!/usr/bin/env bats

# doctor.bats — integration tests for `igris doctor`. End-to-end drift
# classification + --fix + --remove-orphans confirmation flow.

load _helpers.bash

# FR-212d: doctor now reads GLOBAL brain-level state (~/.claude/settings.json
# for hooks, ~/.claude.json for the brain MCP, harness config perms). To keep
# the exit-code assertions HERMETIC (not coupled to the dev's real ~/.claude/),
# every test runs under a sandboxed HOME seeded with a clean baseline:
#   - ~/.claude/settings.json carrying the canonical Igris hooks (no hooks-missing)
#   - ~/.claude.json with a valid igris-brain MCP entry at 600 (no mcp-unregistered)
#   - ~/.igris/config.json with cli_targets:{} (bridge-missing opt-out)
# Tests that want a drift to fire mutate this sandbox in their own body.
#
# `os.homedir()` honors $HOME on this platform, so exporting HOME redirects every
# brain-level read into the sandbox. The brain dir stays IGRIS_BRAIN_DIR (tmp).
setup() {
  stage_brain
  export IGRIS_KEEP_BAK=0
  export SANDBOX_HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$SANDBOX_HOME/.claude"
  # Valid global Igris hooks (mirrors the stub canonical-settings.json).
  printf '%s\n' "$STUB_CANONICAL_HOOKS" > "$SANDBOX_HOME/.claude/settings.json"
  # Valid igris-brain MCP entry pointing at a real on-disk file (600 so the
  # secret-perms class doesn't flag it).
  : > "$SANDBOX_HOME/fake-mcp.js"
  cat > "$SANDBOX_HOME/.claude.json" <<EOF
{ "mcpServers": { "igris-brain": { "type": "stdio", "command": "node", "args": ["$SANDBOX_HOME/fake-mcp.js"], "env": {} } } }
EOF
  chmod 600 "$SANDBOX_HOME/.claude.json"
  # Explicit bridge-missing opt-out (the staged ~/.claude/ would otherwise make
  # detectInstalledCLIs flag a real `claude` on PATH).
  cat > "$IGRIS_BRAIN_DIR/config.json" <<EOF
{ "version": "7.0.0", "cli_targets": {} }
EOF
  chmod 600 "$IGRIS_BRAIN_DIR/config.json"
  export HOME="$SANDBOX_HOME"
}

@test "doctor exits 0 on clean registry" {
  PROJ="$(stage_project clean)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN doctor
  [ "$status" -eq 0 ]
}

@test "doctor exits 1 when the GLOBAL settings.json is missing the Igris hooks block (TD-100 silent-failure, FR-212d)" {
  # FR-212d: the TD-100 silent-failure class is GLOBAL now — overwrite the
  # staged-valid global hooks with a settings file lacking the Igris hooks so the
  # brain-level hooks-missing row fires.
  cat > "$HOME/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "hooks-missing" ]]
}

@test "doctor --fix repairs hooks-missing by refreshing the GLOBAL hooks (FR-212d)" {
  # FR-212d: hooks-missing is a brain-level row read from the GLOBAL
  # ~/.claude/settings.json (sandboxed by setup()). Overwrite the staged-valid
  # global hooks with a settings file LACKING the Igris hooks so the row fires,
  # then assert `--fix` re-merges the canonical Igris hooks into the global file.
  cat > "$HOME/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  run $CLI_BIN doctor --fix
  [ "$status" -eq 0 ]
  # The fix refreshes the GLOBAL ~/.claude/settings.json (the live hooks surface).
  [ -f "$HOME/.claude/settings.json" ]
  run python3 -c "import json,sys; d=json.load(open('$HOME/.claude/settings.json')); print(d['hooks']['SessionEnd'][0]['hooks'][0]['command'])"
  [ "$status" -eq 0 ]
  [ "$output" = "\$HOME/.igris/core/hooks/shared/session_end.sh" ]
}

@test "doctor --remove-orphans --yes deletes ghost-path rows" {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('ghost1','ghost1','/no/such/dir/abc','7.0.0');
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('ghost2','ghost2','/no/such/dir/def','7.0.0');
  "
  run $CLI_BIN doctor --remove-orphans --yes
  [ "$status" -eq 0 ]
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT COUNT(*) FROM projects;"
  [ "$output" = "0" ]
}

@test "doctor surfaces multi-slug-at-one-path (fifty_eco_system triple-slug case)" {
  PROJ="$(stage_project shared)"
  run $CLI_BIN install --slug slug-a "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN install --slug slug-b "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN install --slug slug-c "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "duplicate-path" ]]
}

@test "doctor --remove-orphans prompt advertises the new [y/N/a/all] label (TD-111)" {
  # Seed one orphan row, pipe 'y\n' on stdin so the prompt fires exactly
  # once and we capture the label literal in the same combined stdout/stderr.
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('label-orphan','label-orphan','/no/such/dir/label-orphan','7.0.0');
  "
  # readline writes the prompt to stdout; we send 'y' on stdin to consume it.
  run bash -c "printf 'y\n' | $CLI_BIN doctor --remove-orphans 2>&1"
  [ "$status" -eq 0 ]
  # The literal new label must appear; the legacy `[y/N/a/Y/A]` must not.
  [[ "$output" == *"[y/N/a/all]"* ]]
  [[ "$output" != *"[y/N/a/Y/A]"* ]]
}

@test "doctor handles paths with spaces (TD-100 ghost path)" {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('spaces','spaces','/var/folders/abc/project with spaces','7.0.0');
  "
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "path-missing" ]]
}

@test "doctor --fix: bridge-missing + hooks-missing both fixed in one pass (TD-122)" {
  # TD-122: pre-fix the bridge-missing arm `break`'d, skipping all drift rows
  # after it. Post-fix, the loop continues. FR-212d: `not-installed` was retired
  # (register-only), so the "second class after bridge-missing" is now the
  # brain-level global hooks-missing fix. We stage:
  #   1. a fake `claude` binary on PATH + ~/.claude/ config dir (no Igris hooks),
  #      so detectInstalledCLIs returns claude AND the global hooks-missing fires
  #   2. an ~/.igris/config.json with non-empty cli_targets that LACKS claude —
  #      the bridge-missing condition
  # After `doctor --fix`, BOTH should be repaired in a single invocation.

  # Stage a non-empty cli_targets that LACKS claude (a CLI in our catalog).
  # The detector treats this as bridge-missing iff claude is detected.
  cat > "$IGRIS_BRAIN_DIR/config.json" <<EOF
{ "version": "7.0.0", "cli_targets": { "codex": "ignored" } }
EOF

  # Fake claude on PATH: a stub executable in a temp dir we prepend.
  FAKEPATH="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKEPATH"
  cat > "$FAKEPATH/claude" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$FAKEPATH/claude"

  # Fake HOME with a ~/.claude/ config dir (so claude is "detected") but a
  # settings.json that LACKS the Igris hooks (so the global hooks-missing row
  # fires). detect-cli walks `homedir() + ".claude"`; the global hooks check
  # reads `~/.claude/settings.json`.
  FAKEHOME="$BATS_TEST_TMPDIR/fakehome"
  mkdir -p "$FAKEHOME/.claude"
  cat > "$FAKEHOME/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF

  # Run --fix with the staged env. We tolerate non-zero exit (the bridge-fix arm
  # calls runInit which talks to GitHub releases — out of scope for this minimal
  # fixture). The TD-122 contract is that BOTH fix arms fire in one invocation —
  # pre-fix the bridge-missing arm `break`'d, so the later arm was unreachable.
  HOME="$FAKEHOME" PATH="$FAKEPATH:$PATH" run $CLI_BIN doctor --fix 2>&1
  # The smoking gun: both arms emitted their fix-attempt log lines. If `break`
  # ever returns to the bridge-missing arm (TD-122 regression), the global-hooks
  # refresh message will not appear.
  [[ "$output" =~ "bridge-missing for claude" ]]
  # FR-212d: the second class after bridge-missing is the brain-level global
  # hooks-missing fix.
  [[ "$output" =~ "refreshing the GLOBAL Igris hooks" ]]
}
