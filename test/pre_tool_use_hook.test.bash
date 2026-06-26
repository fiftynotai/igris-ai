#!/usr/bin/env bats

# pre_tool_use_hook.test.bash — FR-212c. The REGISTRATION GATE on the shared
# PreToolUse hook.
#
# The hooks project GLOBALLY now (one ~/.claude/settings.json block fires them
# in EVERY project on the machine). `core/hooks/shared/_gate.sh` no-ops the
# brief-gate OUTSIDE a registered Igris project. This suite pins the polarity:
#   - registered + active brief   -> ALLOW (gate transparent, brief-gate passes)
#   - registered + NO brief        -> DENY  (gate transparent, brief-gate fires)
#   - UNREGISTERED cwd             -> ALLOW (gate no-ops; NEVER deny a non-Igris write)
#   - brain DB ABSENT              -> ALLOW (FAIL-OPEN-TO-NO-OP)
#   - bypass inside a registered project -> ALLOW (the bypass still works above
#                                                  the brief-gate, below the reg-gate)
#
# Test isolation mirrors brief_gate.test.bash: a fresh HOME + a per-test SQLite
# brain DB at $HOME/.igris/memory/knowledge.db (the hook hardcodes that path).
# The sandbox is realpath-normalised (TD-150) so the registered `projects.path`
# matches the gate's `pwd -P` resolution (macOS /tmp -> /private/tmp).
#
# The sandbox dir name avoids the exempt-path tokens (/test/ /tests/ /core/
# /.igris/ /.claude/) so the gate actually fires for the synthetic file_path.

load test_helper

setup() {
  HOOK="$IGRIS_ROOT/core/hooks/shared/pre_tool_use.sh"
  [ -f "$HOOK" ] || { echo "hook not found at $HOOK"; return 1; }
  [ -f "$IGRIS_ROOT/core/hooks/shared/_gate.sh" ] || { echo "_gate.sh missing"; return 1; }

  # TD-150: realpath-resolve so projects.path == the hook's pwd -P.
  SANDBOX="$(cd "$(mktemp -d "${BATS_TMPDIR:-/tmp}/ptureg.XXXXXX")" && pwd -P)"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"

  # Registered project dir + an UNregistered sibling.
  PROJ="$SANDBOX/myproj"; mkdir -p "$PROJ/src"
  UNREG="$SANDBOX/randomrepo"; mkdir -p "$UNREG/src"

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
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL,
      component TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT, project_slug TEXT, instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
  # Register myproj. UNREG is intentionally NOT registered.
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');"
}

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# run_hook <project_dir> <file_path> [extra env...] — native-Claude payload.
run_hook() {
  local proj="$1" fpath="$2"; shift 2
  run bash -c "printf '%s' '{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$fpath\"},\"project_dir\":\"$proj\"}' | HOME='$FAKEHOME' $* bash '$HOOK' 2>&1"
}

# -----------------------------------------------------------------------------
# (1) REGISTERED + active brief -> ALLOW (gate transparent; brief-gate passes).
# -----------------------------------------------------------------------------
@test "(1) registered project + active brief -> allow (gate transparent)" {
  sqlite3 "$DB" "INSERT INTO brief_status (project,brief_id,title,status) VALUES ('myproj','TD-001','t','In Progress');"
  run_hook "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

# -----------------------------------------------------------------------------
# (2) REGISTERED + NO brief -> DENY (gate transparent; brief-gate fires as today).
#     This is the false-NEGATIVE guard: a registered project must STILL be
#     brief-gated — the registration gate must not accidentally no-op it.
# -----------------------------------------------------------------------------
@test "(2) registered project + NO brief -> deny (brief-gate still fires)" {
  run_hook "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]   # hooks always exit 0; deny is via JSON
  [[ "$output" == *"permissionDecision"* ]]
  [[ "$output" == *"deny"* ]]
}

# -----------------------------------------------------------------------------
# (3) UNREGISTERED cwd -> ALLOW (gate no-ops). The misfire guard: never deny a
#     non-Igris project's write, even with NO brief anywhere.
# -----------------------------------------------------------------------------
@test "(3) UNREGISTERED project -> allow (gate no-ops; never deny a non-Igris write)" {
  run_hook "$UNREG" "$UNREG/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

# -----------------------------------------------------------------------------
# (3b) UNREGISTERED cwd that is a SUBDIR of nothing registered -> still ALLOW.
#      (Parent-walk finds no projects.path ancestor.)
# -----------------------------------------------------------------------------
@test "(3b) UNREGISTERED deep subdir -> allow (no registered ancestor)" {
  mkdir -p "$UNREG/a/b/c"
  run_hook "$UNREG/a/b/c" "$UNREG/a/b/c/x.go"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

# -----------------------------------------------------------------------------
# (4) BRAIN DB ABSENT -> ALLOW (FAIL-OPEN-TO-NO-OP). Even for what WOULD be a
#     registered project, an absent brain DB resolves to not-registered -> the
#     gate no-ops -> allow. We must NEVER block work because the brain is gone.
# -----------------------------------------------------------------------------
@test "(4) brain DB absent -> allow (fail-open-to-no-op)" {
  rm -f "$DB"
  run_hook "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

# -----------------------------------------------------------------------------
# (4b) CORRUPT brain DB -> ALLOW (fail-open). A garbage DB file errors the
#      lookup; the gate treats the error as not-registered -> no-op -> allow.
# -----------------------------------------------------------------------------
@test "(4b) corrupt brain DB -> allow (fail-open, never block on a broken brain)" {
  echo "not a sqlite file" > "$DB"
  run_hook "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

# -----------------------------------------------------------------------------
# (5) IGRIS_BYPASS_BRIEF_GATE=1 inside a REGISTERED project -> ALLOW + WARNING.
#     The registration gate sits ABOVE the bypass; inside a registered project
#     the bypass still works exactly as before (no brief, would deny -> bypass
#     allows with a loud warning).
# -----------------------------------------------------------------------------
@test "(5) bypass inside a registered project still allows (gate is above bypass)" {
  run_hook "$PROJ" "$PROJ/src/x.go" "IGRIS_BYPASS_BRIEF_GATE=1"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
  [[ "$output" == *"gate bypassed"* ]]
}

# -----------------------------------------------------------------------------
# (6) Exempt paths are allowed regardless of registration (the is_exempt check
#     is below the gate; but an unregistered exempt path also no-ops to allow).
# -----------------------------------------------------------------------------
@test "(6) registered project + exempt path (.claude/) -> allow" {
  run_hook "$PROJ" "$PROJ/.claude/settings.json"
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

# -----------------------------------------------------------------------------
# (7) Symlinked registered checkout -> the gate's pwd -P normalisation matches
#     the registered REAL path (parity with find_project_slug's TD-150 fix).
# -----------------------------------------------------------------------------
@test "(7) symlinked registered checkout -> gate resolves to real path (still gated)" {
  REALP="$SANDBOX/real-proj"; SYMP="$SANDBOX/sym-proj"
  mkdir -p "$REALP/src"
  ln -s "$REALP" "$SYMP"
  sqlite3 "$DB" "INSERT INTO projects (slug,name,path) VALUES ('realp','realp','$REALP');"
  # No brief for realp -> the gate is transparent (registered via realpath) and
  # the brief-gate DENIES. Proves the gate did NOT no-op the symlinked checkout.
  run_hook "$SYMP" "$SYMP/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}
