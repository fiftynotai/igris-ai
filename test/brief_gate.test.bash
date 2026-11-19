#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
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
load sql_escape_helpers

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
  cleanup_test_temp_dir
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

# =============================================================================
# TD-510 — the brain lookup asks about every SLUG_RE slug.
#
# THE DEFECT. find_active_brief_in_brain refused every slug outside the narrow
# charset `[a-z0-9_-]` before its SQL, so lifeOS, animated-fifty.dev and
# CustomerPulse-Android (valid cli/src/lib/slug.ts SLUG_RE slugs, all in the
# live registry) never reached the brain: their In Progress briefs were
# invisible and every write was DENIED. The check is now `igris_slug_valid`
# (_gate.sh, the one bash spelling of SLUG_RE), and the slug is escaped with
# the unquoted idiom (MAINTAINING row 153).
#
# WORLD. <slug> registered at $PROJ with one In Progress brief, and NO
# ~/.igris/projects/<slug>/briefs, so only the brain can allow. The hook runs
# under /bin/bash, its shebang interpreter (test_standards BR-104), with HOME
# and IGRIS_BRAIN_DIR fenced on one path and the git location variables unset.
#
#   B1   lifeOS                                  allow, quiet      (HEAD: deny)
#   B2   animated-fifty.dev                      allow             (HEAD: deny)
#   B3   o'brien (a quote, outside SLUG_RE)      deny, 0 db_error  (HEAD: deny)
#   B4   _lead, 65 x a (outside SLUG_RE, inside the old charset)
#                                                deny              (HEAD: allow)
#   B4b  64 x a, CustomerPulse-Android           allow             (HEAD: allow, deny)
#   B1L  B1's world allows under LC_ALL=C and en_US.UTF-8 (the check is locale-free)
#   MB1  the pre-TD-510 `case` put back in a scratch copy denies B1's world,
#        under LC_ALL=C: the old filter is a bracket range, which /bin/bash 3.2
#        matches by collation, so under en_US.UTF-8 it admitted capitals and
#        the HEAD verdicts on B1 and B4b were allow (macos-latest CI)
#   MB2  the check deleted, the escape kept: the copy ALLOWS B3's world, so the
#        skip (not a SQL error) is what keeps a quote out of the lookup
#   B6   static pin: neither narrow literal sits on a non-comment line
#   B6n  the pin's self-negative
# Each allow carries its own control: the brief deleted, the same world denies
# and names the slug, so the allow came from the lookup and not from a no-op.
# =============================================================================

# td510_world <slug> — register <slug> at $PROJ with one In Progress brief.
td510_world() {
  local q
  q="$(sql_q "$1")"
  sqlite3 "$DB" "
    INSERT INTO projects (slug,name,path) VALUES ('$q','$q','$PROJ');
    INSERT INTO brief_status (project,brief_id,title,status)
      VALUES ('$q','TD-510','t','In Progress');
  " || return 1
  # Arm: no cache entry, so the filesystem arm cannot allow.
  [ ! -e "$FAKEHOME/.igris/projects/$1" ] || return 1
}

# run_gate_bin <hook> <project_dir> <file_path> — the hook under /bin/bash.
# Sets GATE_RC, GATE_OUT, GATE_ERR (stdout and stderr apart) and GATE_VERDICT
# (allow | deny | other).
run_gate_bin() {
  local hook="$1" proj="$2" fpath="$3" rc=0
  printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"project_dir":"%s"}' \
    "$fpath" "$proj" > "$SANDBOX/td510.json"
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR \
      -u IGRIS_BYPASS_BRIEF_GATE -u IGRIS_PROJECT_DIR -u CLAUDE_PROJECT_DIR \
      HOME="$FAKEHOME" IGRIS_BRAIN_DIR="$FAKEHOME/.igris" \
      /bin/bash "$hook" < "$SANDBOX/td510.json" \
      > "$SANDBOX/td510.out" 2> "$SANDBOX/td510.err" || rc=$?
  GATE_RC="$rc"
  GATE_OUT="$(cat "$SANDBOX/td510.out")"
  GATE_ERR="$(cat "$SANDBOX/td510.err")"
  case "$GATE_OUT" in
    '') GATE_VERDICT=allow ;;
    *'"permissionDecision": "deny"'* | *'"permissionDecision":"deny"'*) GATE_VERDICT=deny ;;
    *) GATE_VERDICT=other ;;
  esac
  echo "${hook#"$SANDBOX"/}: rc=$GATE_RC verdict=$GATE_VERDICT"
  echo "  stdout: [$GATE_OUT]"
  echo "  stderr: [$GATE_ERR]"
}

# td510_allows <slug> — B1/B2/B4b: the hook allows quietly, then, with the
# brief deleted, denies and names <slug> (the control).
td510_allows() {
  local slug="$1"
  td510_world "$slug" || return 1
  run_gate_bin "$HOOK" "$PROJ" "$PROJ/src/x.go"
  [ "$GATE_RC" -eq 0 ] || return 1
  [ "$GATE_VERDICT" = allow ] || return 1
  [[ "$GATE_ERR" != *"WARNING"* ]] || return 1
  [ "$(event_count 'brief_gate.fallback_fired')" -eq 0 ] || return 1
  [ "$(event_count 'brief_gate.db_error')" -eq 0 ] || return 1
  # Control: the same world without the brief denies, naming the slug.
  sqlite3 "$DB" "DELETE FROM brief_status;"
  run_gate_bin "$HOOK" "$PROJ" "$PROJ/src/x.go"
  [ "$GATE_VERDICT" = deny ] || return 1
  [[ "$GATE_OUT" == *"project '$slug' resolved from"* ]] || return 1
}

# td510_denies <slug> — B3/B4: the hook denies, names <slug> (so the brief gate
# ran: the registration gate did not no-op) and logs no db_error.
td510_denies() {
  local slug="$1"
  td510_world "$slug" || return 1
  run_gate_bin "$HOOK" "$PROJ" "$PROJ/src/x.go"
  [ "$GATE_RC" -eq 0 ] || return 1
  [ "$GATE_VERDICT" = deny ] || return 1
  [[ "$GATE_OUT" == *"project '$slug' resolved from"* ]] || return 1
  [[ "$GATE_ERR" != *"WARNING"* ]] || return 1
  [ "$(event_count 'brief_gate.db_error')" -eq 0 ] || return 1
}

# td510_mutant <old|none> — a scratch copy of pre_tool_use.sh and _gate.sh in
# $SANDBOX/mut-<mode>/ whose [[ TD-510 SLUG CHECK ]] block is either replaced
# by the pre-TD-510 `case` (old) or deleted (none). Asserts the mutation
# LANDED (test_standards "Scratch-copy mutation"). Prints the copy's path.
td510_mutant() {
  local mode="$1" dir="$SANDBOX/mut-$1" n_real
  mkdir -p "$dir"
  n_real="$(grep -c 'TD-510 SLUG CHECK' "$HOOK" || true)"
  [ "$n_real" -eq 2 ] || { echo "the [[ TD-510 SLUG CHECK BEGIN/END ]] markers are absent from pre_tool_use.sh ($n_real): the mutation cannot land" >&2; return 1; }
  cp "$REPO_ROOT/core/hooks/shared/_gate.sh" "$dir/_gate.sh"
  python3 - "$HOOK" "$dir/pre_tool_use.sh" "$mode" <<'PY' || return 1
import sys
src, dst, mode = sys.argv[1:4]
OLD = [
    '  case "$slug" in\n',
    '    *[!a-z0-9_-]*|"")\n',
    '      _BRAIN_QUERY_STATUS="skipped"\n',
    '      return 0\n',
    '      ;;\n',
    '  esac\n',
]
out, inside, blocks = [], False, 0
for line in open(src, encoding="utf-8"):
    if "[[ TD-510 SLUG CHECK BEGIN ]]" in line:
        inside = True
        if mode == "old":
            out.extend(OLD)
        continue
    if "[[ TD-510 SLUG CHECK END ]]" in line:
        inside = False
        blocks += 1
        continue
    if not inside:
        out.append(line)
if blocks != 1:
    sys.exit("expected one TD-510 SLUG CHECK block, found %d" % blocks)
open(dst, "w", encoding="utf-8").write("".join(out))
PY
  # Landed: the markers are gone, no live line calls the helper, the escaped
  # lookup survives, and the old literal is present exactly when restored.
  [ "$(grep -c 'TD-510 SLUG CHECK' "$dir/pre_tool_use.sh" || true)" -eq 0 ] || return 1
  [ "$(grep -vE '^[[:space:]]*#' "$dir/pre_tool_use.sh" | grep -c 'igris_slug_valid' || true)" -eq 0 ] || return 1
  [ "$(grep -vE '^[[:space:]]*#' "$HOOK" | grep -c 'igris_slug_valid' || true)" -ge 1 ] || return 1
  # The escape survives: both `q=${slug//...}` sites (this lookup's and
  # output_deny's), and the lookup's SQL still reads the escaped `$q`.
  local esc_real esc_mut
  # shellcheck disable=SC2016  # the escape and SQL lines, matched literally
  esc_real="$(grep -cF 'q=${slug//' "$HOOK" || true)"
  # shellcheck disable=SC2016
  esc_mut="$(grep -cF 'q=${slug//' "$dir/pre_tool_use.sh" || true)"
  [ "$esc_real" -eq 2 ] && [ "$esc_mut" -eq "$esc_real" ] || return 1
  # shellcheck disable=SC2016
  [ "$(grep -cF "WHERE project = '\$q' AND replace(" "$dir/pre_tool_use.sh" || true)" -eq 1 ] || return 1
  local old_n=0
  [ "$mode" = old ] && old_n=1
  [ "$(grep -vE '^[[:space:]]*#' "$dir/pre_tool_use.sh" | grep -cF '*[!a-z0-9_-]*' || true)" -eq "$old_n" ] || return 1
  printf '%s\n' "$dir/pre_tool_use.sh"
}

@test "(B1) TD-510: lifeOS (mixed case, a SLUG_RE slug) with an In Progress brief -> allow, quiet" {
  td510_allows lifeOS
}

@test "(B2) TD-510: animated-fifty.dev (a dot) with an In Progress brief -> allow" {
  td510_allows animated-fifty.dev
}

@test "(B3) TD-510: o'brien (a quote, outside SLUG_RE) -> deny, and the lookup never ran (0 db_error)" {
  td510_denies "o'brien"
}

@test "(B4) TD-510: _lead (a leading underscore, outside SLUG_RE, inside the old charset) -> deny" {
  td510_denies _lead
}

@test "(B4) TD-510: a 65-character lowercase slug (over SLUG_RE's 64) -> deny" {
  local s
  s="$(printf '%*s' 65 '' | tr ' ' a)"
  [ "${#s}" -eq 65 ] || return 1
  td510_denies "$s"
}

@test "(B4b) TD-510: a 64-character slug (SLUG_RE's longest) -> allow" {
  local s
  s="$(printf '%*s' 64 '' | tr ' ' a)"
  [ "${#s}" -eq 64 ] || return 1
  td510_allows "$s"
}

@test "(B4b) TD-510: CustomerPulse-Android (capitals) -> allow" {
  td510_allows CustomerPulse-Android
}

@test "(MB1) TD-510 mutation: the pre-TD-510 charset case put back denies B1's world (lifeOS), under LC_ALL=C" {
  local mutant
  # The old filter is a bracket RANGE in a case glob. /bin/bash 3.2 matches a
  # range by the locale's collation, so under en_US.UTF-8 `[a-z]` admits `O`
  # and the old case let lifeOS through (macos-latest CI, run 44496245585);
  # bash 5 keeps ranges ASCII (globasciiranges). Pin the locale in which the
  # old filter refused capitals. The real hook is locale-free (B1L).
  export LC_ALL=C
  mutant="$(td510_mutant old)" || return 1
  td510_world lifeOS || return 1
  run_gate_bin "$HOOK" "$PROJ" "$PROJ/src/x.go"
  [ "$GATE_VERDICT" = allow ] || return 1
  run_gate_bin "$mutant" "$PROJ" "$PROJ/src/x.go"
  [ "$GATE_VERDICT" = deny ] || return 1
  [[ "$GATE_OUT" == *"project 'lifeOS' resolved from"* ]] || return 1
}

@test "(B1L) TD-510: lifeOS allows under LC_ALL=C and en_US.UTF-8 (the real check is locale-free)" {
  local loc v=""
  td510_world lifeOS || return 1
  for loc in C en_US.UTF-8; do
    LC_ALL="$loc" run_gate_bin "$HOOK" "$PROJ" "$PROJ/src/x.go"
    echo "LC_ALL=$loc (charmap $(LC_ALL="$loc" locale charmap 2>/dev/null)): $GATE_VERDICT"
    v="$v$GATE_VERDICT "
  done
  [ "$v" = "allow allow " ] || return 1
}

@test "(MB2) TD-510 mutation: with the check deleted the escaped lookup ALLOWS B3's world (o'brien)" {
  local mutant
  mutant="$(td510_mutant none)" || return 1
  td510_world "o'brien" || return 1
  run_gate_bin "$HOOK" "$PROJ" "$PROJ/src/x.go"
  [ "$GATE_VERDICT" = deny ] || return 1
  run_gate_bin "$mutant" "$PROJ" "$PROJ/src/x.go"
  # The escape is sound: the quoted slug reaches SQL, finds the brief, and
  # nothing errors. So the real hook's deny is the skip, by design.
  [ "$GATE_VERDICT" = allow ] || return 1
  [[ "$GATE_ERR" != *"WARNING"* ]] || return 1
  [ "$(event_count 'brief_gate.db_error')" -eq 0 ] || return 1
}

# narrow_slug_filter_lines [root] — `<path>:<line>:<text>` for every
# non-comment line under core/hooks, core/git-hooks, core/scripts, scripts and
# core/skills that carries a pre-TD-510 narrow slug literal (`*[!a-z0-9_-]*`
# or `^[a-z0-9_-]+$`).
narrow_slug_filter_lines() {
  local root="${1:-$IGRIS_ROOT}" d
  for d in core/hooks core/git-hooks core/scripts scripts core/skills; do
    [ -d "$root/$d" ] || continue
    grep -rnF -e '*[!a-z0-9_-]*' -e '^[a-z0-9_-]+$' "$root/$d" 2>/dev/null \
      | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
      | sed "s|^$root/||"
  done
  return 0
}

@test "(B6) TD-510: no live line in the hooks, scripts or skills filters a slug with the narrow charset" {
  local d
  for d in core/hooks core/git-hooks core/scripts scripts core/skills; do
    [ -d "$IGRIS_ROOT/$d" ] || { echo "scan root missing: $d"; return 1; }
  done
  run narrow_slug_filter_lines
  echo "$output"
  [ "$status" -eq 0 ] || return 1
  [ -z "$output" ] || return 1
}

@test "(B6n) TD-510: the narrow-charset scanner reports a planted site in each scope and exempts a comment" {
  local plant="$SANDBOX/plant"
  mkdir -p "$plant/core/hooks/shared" "$plant/core/skills/x"
  {
    printf '%s\n' '#!/bin/bash'
    printf '%s\n' '  case "$slug" in'
    printf '%s\n' '    *[!a-z0-9_-]*|"") return 0 ;;'
    printf '%s\n' '  esac'
    printf '%s\n' '  # the old filter was *[!a-z0-9_-]* — a comment is not a site'
  } > "$plant/core/hooks/shared/x.sh"
  printf '%s\n' 'if [[ ! "$PROJECT_SLUG" =~ ^[a-z0-9_-]+$ ]]; then' > "$plant/core/skills/x/SKILL.md"
  run narrow_slug_filter_lines "$plant"
  echo "$output"
  [ "$status" -eq 0 ] || return 1
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 2 ] || return 1
  [[ "$output" == *"core/hooks/shared/x.sh:3:"* ]] || return 1
  [[ "$output" == *"core/skills/x/SKILL.md:1:"* ]] || return 1
  [[ "$output" != *"x.sh:5:"* ]] || return 1
}
