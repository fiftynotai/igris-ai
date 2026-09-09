#!/usr/bin/env bats

# brief_gate.test.bash — TD-150. Tests for the hardened pre_tool_use.sh
# brief-gate (loud-on-bypass / loud-on-error / loud-on-fallback-fire,
# cache-less, realpath-normalised, IGRIS_BYPASS_BRIEF_GATE escape hatch).
#
# Test isolation
# --------------
# Every test sets HOME to a fresh scratch dir and seeds a per-test SQLite
# brain DB at $HOME/.igris/memory/knowledge.db. The hook hardcodes
# $HOME/.igris/memory/knowledge.db for both the brief lookup and the
# event_log INSERT, so HOME-override isolates the entire fixture.
#
# The hook also treats any path containing /test/, /tests/, /core/, /.igris/,
# /.claude/ as exempt. The scratch sandbox dir name must avoid those tokens
# so the gate actually fires for the synthetic file_path we pass.
#
# /tmp leakage check (case g)
# ---------------------------
# Per TD-150 the /tmp/igris_brief_gate_cache file must NEVER be created.
# We delete it in setup() and assert it's still absent after each call.
#
# Past mistakes to avoid (forger memory)
# --------------------------------------
# Memory ID 25: when using chmod-000 fixtures, restore permissions BEFORE
# assertions/teardown (else `rm -rf` on the scratch dir fails). We use
# `echo "garbage" > $DB` instead of chmod-000 for the corrupt-file case.
# Memory ID 287: macOS system sqlite3 can't load vec0 — we only create
# plain projects/brief_status/event_log tables, no vec0 / FTS5.

load test_helper

setup() {
  rm -f /tmp/igris_brief_gate_cache

  REPO_ROOT="$IGRIS_ROOT"
  HOOK="$REPO_ROOT/core/hooks/shared/pre_tool_use.sh"
  [ -f "$HOOK" ] || { echo "hook not found at $HOOK"; return 1; }

  # Sandbox dir must avoid /test/ /tests/ /core/ /.igris/ /.claude/ — those
  # are exempt-path tokens. `ptu` is short and token-free.
  # FR-212c: realpath-normalise (cd && pwd -P) so the registered projects.path
  # matches the registration gate's `pwd -P` resolution (macOS /tmp ->
  # /private/tmp). Before FR-212c the brief-gate's basename fallback masked the
  # mismatch; the registration gate requires a REAL projects.path match (no
  # basename fallback by design), so the sandbox must resolve to its real path.
  SANDBOX="$(cd "$(mktemp -d "${BATS_TMPDIR:-/tmp}/ptu.XXXXXX")" && pwd -P)"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"

  # Project dir under the sandbox (NOT under FAKEHOME — keeps the hook from
  # accidentally exempting it via the /.igris/ token check).
  PROJ="$SANDBOX/myproj"
  mkdir -p "$PROJ/src"

  # Default brain DB schema: projects + brief_status + event_log.
  # Mirrors brain-mcp-server/src/engine/components/monitoring/schema.ts.
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT,
      project_slug TEXT,
      instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
}

teardown() {
  rm -f /tmp/igris_brief_gate_cache
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# run_hook <project_dir> <file_path> [extra env...]
#   - Wraps the hook invocation with a fake HOME + native-Claude stdin payload.
#   - Captures combined stdout + stderr + exit status via bats `run`.
run_hook() {
  local proj="$1" fpath="$2"; shift 2
  run bash -c "printf '%s' '{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$fpath\"},\"project_dir\":\"$proj\"}' | HOME='$FAKEHOME' $* bash '$HOOK' 2>&1"
}

# run_hook_split_stderr <project_dir> <file_path> [extra env...]
#   - Like run_hook but captures stdout and stderr separately so we can
#     assert on stderr-only WARNING messages without polluting stdout
#     assertions (which check for the deny JSON).
run_hook_split_stderr() {
  local proj="$1" fpath="$2"; shift 2
  STDOUT_FILE="$SANDBOX/stdout.$$"
  STDERR_FILE="$SANDBOX/stderr.$$"
  run bash -c "printf '%s' '{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$fpath\"},\"project_dir\":\"$proj\"}' | HOME='$FAKEHOME' $* bash '$HOOK' >'$STDOUT_FILE' 2>'$STDERR_FILE'"
  STDOUT="$(cat "$STDOUT_FILE" 2>/dev/null || echo '')"
  STDERR="$(cat "$STDERR_FILE" 2>/dev/null || echo '')"
}

# event_count <event_name> — count rows in event_log with the given event_name.
event_count() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM event_log WHERE event_name = '$1';" 2>/dev/null || echo "0"
}

# -----------------------------------------------------------------------------
# (a) Brain DB has an active brief -> ALLOW, quiet (no WARNING, no event row).
# -----------------------------------------------------------------------------
@test "(a) brain has active brief -> allow + quiet" {
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');
    INSERT INTO brief_status (project,brief_id,title,status)
      VALUES ('myproj','TD-001','t','In Progress');
  "
  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$STDOUT" != *"permissionDecision"* ]]
  [[ "$STDERR" != *"WARNING"* ]]
  [ "$(event_count 'brief_gate.bypassed')" -eq 0 ]
  [ "$(event_count 'brief_gate.fallback_fired')" -eq 0 ]
  [ "$(event_count 'brief_gate.db_error')" -eq 0 ]
}

# -----------------------------------------------------------------------------
# TD-340 helpers.
#
# WHY `|| return 1` AND NOT A BARE `[[ ... ]]`: bash does NOT fire the ERR trap
# for a `[[ ]]` compound conditional, and bats-core 1.12 detects mid-test
# failures via that trap (errexit itself is OFF inside a test body — verified:
# `set -o` reports `errexit off`). A bare `[[ ... ]]` that is not the FINAL
# command of the @test body therefore fails SILENTLY and the test still
# reports `ok`. Single-bracket `[ ... ]` (the `test` builtin) IS trapped.
# These TD-340 assertions must be able to fail, so every substring check is
# written `[[ ... ]] || return 1`. See the TD-340 report for the repo-wide
# count of pre-existing vacuous assertions.
seed_brief_with_status() {
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');
    INSERT INTO brief_status (project,brief_id,title,status)
      VALUES ('myproj','$1','t','$2');
  "
}

# -----------------------------------------------------------------------------
# (a2) TD-340: the SAME active brief spelled 'InProgress' (no space) -> ALLOW.
#      The pre-TD-340 gate filtered `status = 'In Progress'`, which cannot
#      match, so a genuinely-active brief looked like NO brief and the gate
#      DENIED every write. Unlike the pre-commit phase guard (which failed
#      OPEN on the same token), this site fails CLOSED — a nuisance, not a
#      hole — but it is the same defect and is fixed with the same fold.
# -----------------------------------------------------------------------------
@test "(a2) TD-340: active brief spelled 'InProgress' -> allow + quiet" {
  seed_brief_with_status "TD-340" "InProgress"
  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$STDOUT" != *"permissionDecision"* ]] || return 1
  [[ "$STDERR" != *"WARNING"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (a3) TD-340 notation generalisation: a FOURTH notation ('in-progress') is
#      also recognised. Fails if the hole is "fixed" by hardcoding a second
#      literal instead of folding notation.
# -----------------------------------------------------------------------------
@test "(a3) TD-340: a fourth notation ('in-progress') is recognised as active" {
  seed_brief_with_status "TD-341" "in-progress"
  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$STDOUT" != *"permissionDecision"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (a4) TD-340 ASYMMETRY control: 'Completed' is a TERMINAL state and must NOT
#      be folded into in-flight. Same code path as (a2)/(a3) — same seed helper,
#      same query, only the status WORD differs -> the gate must DENY. This is
#      what proves the fold collapses notation without collapsing vocabulary.
# -----------------------------------------------------------------------------
@test "(a4) TD-340: terminal 'Completed' is NOT treated as an active brief" {
  seed_brief_with_status "TD-342" "Completed"
  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$STDOUT" == *"deny"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (b) Brain has no active brief, no .md fallback -> QUIET DENY.
# -----------------------------------------------------------------------------
@test "(b) brain empty + no .md fallback -> quiet deny (no WARNING, no event)" {
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');
  "
  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]   # exit code is always 0; deny is via JSON
  [[ "$STDOUT" == *"permissionDecision"* ]]
  [[ "$STDOUT" == *"deny"* ]]
  [[ "$STDERR" != *"WARNING"* ]]
  [ "$(event_count 'brief_gate.bypassed')" -eq 0 ]
  [ "$(event_count 'brief_gate.fallback_fired')" -eq 0 ]
  [ "$(event_count 'brief_gate.db_error')" -eq 0 ]
}

# -----------------------------------------------------------------------------
# (c) Corrupt brain DB file (garbage bytes) -> FR-212c: the registration gate
#     fails OPEN. A fully-corrupt DB means the gate cannot confirm registration
#     (it can't read the `projects` table), so it treats the project as
#     not-registered and NO-OPS the hook (exit 0, allow) ABOVE the brief-gate.
#     The brief-gate's TD-150 db_error WARNING therefore does NOT fire here —
#     that path is now reachable only when the project IS registered but the
#     brief SELECT errors (a readable `projects`, broken `brief_status`),
#     exercised in (c2) below. The FR-212c contract: NEVER block a write because
#     the brain is unavailable, and don't run the brief-gate (or its WARNINGs)
#     when registration can't be confirmed.
# -----------------------------------------------------------------------------
@test "(c) corrupt brain DB file -> gate fails open: allow, no brief-gate WARNING" {
  # Overwrite the DB with garbage. sqlite3 will refuse to open it.
  echo "not a sqlite file" > "$DB"

  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  # Allowed (no deny JSON) — the gate no-ops on an unreadable brain.
  [[ "$STDOUT" != *"permissionDecision"* ]]
  # The brief-gate never ran, so its db_error WARNING is absent.
  [[ "$STDERR" != *"brain DB query errored"* ]]
}

# -----------------------------------------------------------------------------
# (c2) Brain DB openable but brief_status table missing/renamed so the
#      SELECT errors -> WARNING + an event_log row IS actually inserted
#      (event_log table is still intact so the INSERT succeeds).
# -----------------------------------------------------------------------------
@test "(c2) brain DB schema-error (brief_status missing) -> WARNING + event_log row" {
  # Drop brief_status; leave event_log alone so emit_brief_gate_event can write.
  sqlite3 "$DB" "DROP TABLE brief_status;"
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');
  "

  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$STDERR" == *"WARNING"* ]]
  [[ "$STDERR" == *"brain DB query errored"* ]]
  [ "$(event_count 'brief_gate.db_error')" -ge 1 ]
}

# -----------------------------------------------------------------------------
# (d) Brain empty + stale `.md` exists in v6 brain-directory cache ->
#     WARNING + `brief_gate.fallback_fired` event + allow.
# -----------------------------------------------------------------------------
@test "(d) brain empty + stale .md fallback hit -> WARNING + fallback_fired event + allow" {
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');
  "
  mkdir -p "$FAKEHOME/.igris/projects/myproj/briefs"
  cat > "$FAKEHOME/.igris/projects/myproj/briefs/BR-999.md" <<'MD'
# BR-999

**Status:** In Progress
MD

  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$STDOUT" != *"permissionDecision"* ]]
  [[ "$STDERR" == *"WARNING"* ]]
  [[ "$STDERR" == *"brain DB returned no active brief"* ]]
  [ "$(event_count 'brief_gate.fallback_fired')" -ge 1 ]
}

# -----------------------------------------------------------------------------
# (e) IGRIS_BYPASS_BRIEF_GATE=1 -> allow + WARNING + `brief_gate.bypassed` event.
# -----------------------------------------------------------------------------
@test "(e) IGRIS_BYPASS_BRIEF_GATE=1 -> allow + WARNING + bypassed event" {
  # Brain empty and no .md — would normally deny. Bypass must override that.
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');
  "

  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go" "IGRIS_BYPASS_BRIEF_GATE=1"
  [ "$status" -eq 0 ]
  [[ "$STDOUT" != *"permissionDecision"* ]]
  [[ "$STDERR" == *"WARNING"* ]]
  [[ "$STDERR" == *"gate bypassed"* ]]
  [ "$(event_count 'brief_gate.bypassed')" -ge 1 ]
}

# -----------------------------------------------------------------------------
# (f) Symlinked PROJECT_DIR -> find_project_slug resolves via pwd -P to the
#     real path's registered slug. Without the TD-150 realpath normalisation,
#     the parent-walk would see the symlinked path and miss the projects row.
# -----------------------------------------------------------------------------
@test "(f) symlinked PROJECT_DIR -> find_project_slug resolves to real path slug" {
  REAL_PROJ="$SANDBOX/real-proj"
  SYM_PROJ="$SANDBOX/sym-proj"
  mkdir -p "$REAL_PROJ/src"
  ln -s "$REAL_PROJ" "$SYM_PROJ"

  # Register projects row at the REAL path. Brief is for the slug 'realslug'.
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('realslug','realslug','$REAL_PROJ');
    INSERT INTO brief_status (project,brief_id,title,status)
      VALUES ('realslug','TD-002','t','In Progress');
  "

  # Hook is invoked via the SYMLINKED path. Without pwd -P, the registration
  # gate (and find_project_slug) would see "$SYM_PROJ" and miss the projects
  # row -> the gate would no-op (allow). With pwd -P, the symlink resolves to
  # REAL_PROJ -> 'realslug' is registered -> the gate is transparent -> the
  # brief-gate runs -> the In Progress brief allows.
  run_hook_split_stderr "$SYM_PROJ" "$SYM_PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$STDOUT" != *"permissionDecision"* ]]

  # Control (FR-212c): keep 'realslug' REGISTERED at REAL_PROJ but delete the
  # BRIEF. The symlinked invocation must still resolve via pwd -P to the
  # registered real path (so the gate is transparent), and the brief-gate must
  # then DENY (no active brief). A DENY here proves the realpath resolution
  # fired — basename ("sym-proj") would be UNregistered, the gate would no-op,
  # and the result would be ALLOW (not deny).
  sqlite3 "$DB" "DELETE FROM brief_status;"
  run_hook_split_stderr "$SYM_PROJ" "$SYM_PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [[ "$STDOUT" == *"deny"* ]]
}

# -----------------------------------------------------------------------------
# (g) Two rapid invocations -> both query brain DB fresh. No /tmp cache file
#     is created (proves the TD-150 cache removal).
# -----------------------------------------------------------------------------
@test "(g) two rapid invocations -> no /tmp/igris_brief_gate_cache; both query fresh" {
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('myproj','myproj','$PROJ');
    INSERT INTO brief_status (project,brief_id,title,status)
      VALUES ('myproj','TD-003','t','In Progress');
  "

  # Invocation 1
  run_hook_split_stderr "$PROJ" "$PROJ/src/x.go"
  [ "$status" -eq 0 ]
  [ ! -e /tmp/igris_brief_gate_cache ]

  # Invocation 2
  run_hook_split_stderr "$PROJ" "$PROJ/src/y.go"
  [ "$status" -eq 0 ]
  [ ! -e /tmp/igris_brief_gate_cache ]

  # Belt-and-braces: corrupt the brief_status table so each call errors.
  # If a cache existed, only the first call would log db_error; without the
  # cache, BOTH calls hit the DB fresh -> 2 db_error rows.
  sqlite3 "$DB" "DROP TABLE brief_status;"
  run_hook_split_stderr "$PROJ" "$PROJ/src/a.go"
  run_hook_split_stderr "$PROJ" "$PROJ/src/b.go"
  [ "$(event_count 'brief_gate.db_error')" -ge 2 ]
}
