#!/usr/bin/env bats

# pre-tool-use-hook.bats — TD-146. Exercises the brief-gate hook's
# brain-DB-first brief lookup and parent-walk slug resolution.
#
# The hook hardcodes $HOME/.igris/memory/knowledge.db and
# $HOME/.igris/projects/<slug>/briefs — it does NOT honor IGRIS_BRAIN_DIR.
# So every test runs the hook under a fake HOME and seeds a TEMP brain DB
# (never the real ~/.igris/memory/knowledge.db).
#
# The hook also treats any path containing /test/, /tests/, /core/, /.igris/,
# /.claude/ as exempt (always-allow), so the sandbox lives under a mktemp
# dir whose components avoid those tokens — NOT under $BATS_TEST_TMPDIR
# (which contains `/test/N`). We clean it up in teardown().
#
# /tmp/igris_brief_gate_cache is wiped each test to defeat the 60s mtime TTL.

load _helpers.bash

setup() {
  rm -f /tmp/igris_brief_gate_cache
  # Repo root = $CLI_DIST/../.. (CLI_DIST is .../<repo>/cli/dist, from _helpers.bash).
  REPO_ROOT="$(cd "$CLI_DIST/../.." && pwd)"
  HOOK="$REPO_ROOT/core/hooks/shared/pre_tool_use.sh"
  [ -f "$HOOK" ] || { echo "hook not found at $HOOK"; return 1; }

  SANDBOX="$(mktemp -d "$BATS_TMPDIR/ptu.XXXXXX")"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"
  sqlite3 "$DB" "
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, tech_stack TEXT,
      igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, brief_type TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT, effort TEXT, phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
}

teardown() {
  rm -f /tmp/igris_brief_gate_cache
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# run_hook <project_dir> <file_path> — pipes the native-Claude payload JSON to
# the hook under the fake HOME, capturing combined output + exit status in
# bats' $output / $status.
run_hook() {
  run bash -c "printf '%s' '{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$2\"},\"project_dir\":\"$1\"}' | HOME='$FAKEHOME' bash '$HOOK'"
}

@test "brain DB has In Progress brief for slug -> hook allows (exit 0, no deny)" {
  PROJ="$SANDBOX/igris-ai"; mkdir -p "$PROJ/src"
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('igris-ai','igris-ai','$PROJ');
    INSERT INTO brief_status (project,brief_id,title,status) VALUES ('igris-ai','TD-146','t','In Progress');
  "
  run_hook "$PROJ" "$PROJ/src/foo.ts"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]   # no deny JSON
}

@test "cwd in subdirectory (cli/) -> parent-walk finds registered slug -> allow" {
  PROJ="$SANDBOX/igris-ai"; mkdir -p "$PROJ/cli/src"
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('igris-ai','igris-ai','$PROJ');
    INSERT INTO brief_status (project,brief_id,title,status) VALUES ('igris-ai','TD-146','t','In Progress');
  "
  run_hook "$PROJ/cli" "$PROJ/cli/src/foo.ts"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

@test "no brief in brain DB or filesystem -> hook denies with helpful message" {
  PROJ="$SANDBOX/igris-ai"; mkdir -p "$PROJ/src"
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('igris-ai','igris-ai','$PROJ');"
  run_hook "$PROJ" "$PROJ/src/foo.ts"
  [ "$status" -eq 0 ]                          # hooks always exit 0
  [[ "$output" == *"No active brief found"* ]]
  [[ "$output" == *"permissionDecision"* ]]    # deny JSON emitted
}

@test "brain DB missing -> degrades to v4 filesystem brief stub (still allows)" {
  # Covers Decision 3 layer 1: sqlite3 present but brain DB absent. With the
  # DB gone, find_project_slug falls back to basename(PROJECT_DIR)='igris-ai'
  # and the v4 filesystem branch finds the stub. Same path exercises the
  # no-sqlite3 case.
  rm -f "$DB"
  PROJ="$SANDBOX/igris-ai"; mkdir -p "$PROJ/src"
  mkdir -p "$FAKEHOME/.igris/projects/igris-ai/briefs"
  printf '**Status:** In Progress\n' > "$FAKEHOME/.igris/projects/igris-ai/briefs/TD-099.md"
  run_hook "$PROJ" "$PROJ/src/foo.ts"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

@test "PROJECT_DIR basename with space -> brain-DB branch skipped, v4 fallback resolves" {
  # Covers Decision 1: slug-regex rejection. basename = 'proj with spaces'
  # fails ^[a-z0-9_-]+$, so find_active_brief_in_brain returns empty without
  # touching SQL. The v4 fallback (literal slug dir) supplies the brief; the
  # contract verified here is "no crash, no mis-interpolation".
  PROJ="$SANDBOX/proj with spaces"; mkdir -p "$PROJ/src"
  mkdir -p "$FAKEHOME/.igris/projects/proj with spaces/briefs"
  printf '**Status:** In Progress\n' > "$FAKEHOME/.igris/projects/proj with spaces/briefs/X.md"
  run_hook "$PROJ" "$PROJ/src/foo.ts"
  [ "$status" -eq 0 ]                          # no crash despite the space
  [[ "$output" != *"permissionDecision"* ]]    # fallback found the stub
}
