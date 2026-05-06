#!/usr/bin/env bats

# doctor.bats — integration tests for `igris doctor`. End-to-end drift
# classification + --fix + --remove-orphans confirmation flow.

load _helpers.bash

setup() {
  stage_brain
  STUB_REPO="$BATS_TEST_TMPDIR/stub-repo"
  mkdir -p "$STUB_REPO/scripts"
  cat > "$STUB_REPO/scripts/igris_install.sh" <<'EOF'
#!/bin/bash
exit 0
EOF
  chmod +x "$STUB_REPO/scripts/igris_install.sh"
  cd "$STUB_REPO"
  export IGRIS_KEEP_BAK=0
}

@test "doctor exits 0 on clean registry" {
  PROJ="$(stage_project clean)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  run $CLI_BIN doctor
  [ "$status" -eq 0 ]
}

@test "doctor exits 1 with drift table when settings.json missing hooks block (TD-100 silent-failure)" {
  PROJ="$(stage_project td100)"
  cat > "$PROJ/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  # Insert registry row directly via sqlite (skip install; we want exactly the drift state).
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('td100','td100','$PROJ','7.0.0');
  "
  run $CLI_BIN doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "hooks-missing" ]]
}

@test "doctor --fix repairs hooks-missing" {
  PROJ="$(stage_project fixme)"
  cat > "$PROJ/.claude/settings.json" <<EOF
{ "includeGitInstructions": false }
EOF
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('fixme','fixme','$PROJ','7.0.0');
  "
  run $CLI_BIN doctor --fix
  [ "$status" -eq 0 ]
  # After --fix, settings.json should have the canonical SessionEnd command.
  run python3 -c "import json,sys; d=json.load(open('$PROJ/.claude/settings.json')); print(d['hooks']['SessionEnd'][0]['hooks'][0]['command'])"
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
