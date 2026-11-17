#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# phase_guard.test.bash — FR-186 / G-01R / TD-494. Tests for the PI-004 phase
# guard in scripts/git-hooks/pre-commit.
#
# History. G-01R re-pointed brief discovery from the retired
# session/CURRENT_SESSION.md to the brain `instances` registry. That guard read
# the brief of the NEWEST active instance of the project on this machine, then
# fell back to the newest per-instance session file, then to the legacy file.
# TD-494 replaces "newest" with "the committing session". The hook identifies
# the session, in this order:
#   S1  IGRIS_INSTANCE_ID, when it is shaped like an id (letters, digits and
#       hyphens, 8 to 64 characters) and names an active row of this project
#       on this machine. A well-shaped id that names no such row leaves the
#       session unidentified; it never falls through to a guess.
#   S2  owner-process ancestry: a row whose owner_pid is an ancestor of the
#       hook AND whose owner_started_at equals that pid's trimmed
#       `ps -o lstart=` (pid reuse is defeated). The nearest ancestor wins.
#   S3  the one live row (future lease, or a verified owner) whose
#       project_path is this worktree root.
# Unidentified (operator decision D1): fail open with ONE notice line, but only
# when the project has at least one active instance on this machine. The gate
# decision itself is unchanged: brief_status.phase BUILDING|TESTING refuses.
# NULL, '' and `none` (any case, any surrounding space) mean "no brief".
#
# Test isolation
# --------------
# The hook hardcodes $HOME/.igris/memory/knowledge.db and
# $HOME/.igris/projects/<project>/session/..., so a fresh HOME scratch dir
# isolates the whole fixture. Each test runs the hook from inside a sandbox git
# repo named `gproj`. The fixture brain has no `projects` table, so the slug is
# `gproj` on HEAD (basename of the toplevel) and after TD-359 (basename of the
# main checkout). The (s3) worktrees are `$SANDBOX/a/gproj` and
# `$SANDBOX/b/gproj` for the same reason: their red isolates the "newest
# instance" defect from the slug defect. The sandbox path is realpath'd
# (`pwd -P`) because the hook compares `project_path` with the realpath of
# `git rev-parse --show-toplevel`.
#
# Every seeded row carries project_path = the repo realpath and a future lease
# unless the case says otherwise, so a single local row is identified through
# S3 on the new hook and is the newest row on HEAD: the pre-TD-494 cases keep
# their meaning on both.
#
# Why exit code is the contract: when the guard fires it `exit 1` at the top of
# the hook (before any validator). When it does NOT fire, the hook proceeds;
# with no enum/lockfile/harness/skill files staged the remaining validators are
# all skipped and the hook exits 0. So: guard-fires <=> exit 1, otherwise exit 0.
#
# The (s2m) mutation control relies on one structural contract in the hook:
# the S2 start-time comparison sits between the marker lines
#   # TD-494 S2 lstart: begin
#   # TD-494 S2 lstart: end
# (it holds the `ps -o lstart=` read or its compare), and deleting that block
# leaves a pid-only match. Same idiom as the BR-100 identity markers (g5).
#
# Past mistakes to avoid (forger memory)
# --------------------------------------
# Memory ID 287: macOS system sqlite3 can't load vec0/FTS5 — we only create
# plain instances + brief_status tables (no vec0 / FTS5).
# Memory ID 29: cover the edge verdicts (fail-open tiers, machine
# disambiguation), not just the happy path.

load test_helper

HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/pre-commit"

# Instance ids shaped like the ids `igris session register` mints, so S1 can
# parse them. Their first 8 characters are what the refusal prints.
ID_A="aaaaaaaa-0000-4000-8000-00000000000a"
ID_B="bbbbbbbb-0000-4000-8000-00000000000b"
ID_C="cccccccc-0000-4000-8000-00000000000c"
ID_F="ffffffff-0000-4000-8000-00000000000f"
ID_M="12345678-aaaa-4bbb-8ccc-1234567890ab"
ID_U="eeeeeeee-0000-4000-8000-00000000000e"
ID_ABSENT="dddddddd-0000-4000-8000-00000000000d"

NOTICE="phase-guard: committing session not identified"

setup() {
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"
  # A value exported by the caller's shell would steer S1 in every case.
  unset IGRIS_INSTANCE_ID

  HOSTNAME_LOCAL="$(hostname)"
  STRANGER_PID=""

  # Sandbox scratch dir, realpath'd (macOS TMPDIR sits under a /var symlink).
  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/pg.XXXXXX")"
  [ -n "$SANDBOX" ] || { echo "mktemp -d returned an empty path"; return 1; }
  SANDBOX="$(cd "$SANDBOX" && pwd -P)"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"

  PROJECT="gproj"
  REPO="$SANDBOX/$PROJECT"
  mkdir -p "$REPO"
  # Initialise a real git repo so `git rev-parse --show-toplevel` resolves.
  git -C "${REPO:?}" init -q
  git -C "${REPO:?}" config user.email t@t.t
  git -C "${REPO:?}" config user.name t
  # The hook lives at .git/hooks/pre-commit normally; we invoke the SOURCE hook
  # directly with cwd = repo so REPO_ROOT resolves to $REPO.

  INSTANCES_DIR="$FAKEHOME/.igris/projects/$PROJECT/session/instances"
  mkdir -p "$INSTANCES_DIR"

  # instances (the live v5+ shape: owner identity, lease, machine id) +
  # brief_status (mirrors brain-mcp-server/src/db.ts).
  create_instances_table
  sqlite3 "$DB" "
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, brief_type TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT, effort TEXT, phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
}

teardown() {
  if [ -n "${STRANGER_PID:-}" ]; then kill "$STRANGER_PID" 2>/dev/null || true; fi
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
  cleanup_test_temp_dir
}

# create_instances_table [no-machine-id] — (re)create `instances`. The default
# carries machine_id (instances v5); `no-machine-id` is the pre-v5 brain (g4).
create_instances_table() {
  local mid_col=", machine_id TEXT"
  [ "${1:-}" = "no-machine-id" ] && mid_col=""
  sqlite3 "$DB" "
    DROP TABLE IF EXISTS instances;
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      machine_hostname TEXT NOT NULL,
      machine_os TEXT,
      project_slug TEXT,
      project_path TEXT,
      current_brief TEXT,
      current_phase TEXT,
      current_task TEXT,
      status TEXT DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}',
      owner_pid INTEGER,
      owner_started_at TEXT,
      lease_expires_at TEXT$mid_col
    );
  "
}

# run_guard [extra env...] — invoke the source hook with cwd=$REPO and a fake
# HOME. Captures combined stdout+stderr + exit status via bats `run`.
run_guard() {
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' $* bash '$HOOK_SRC' 2>&1"
}

# run_guard_in <dir> [extra env...] — the same, from another directory.
run_guard_in() {
  local dir="$1"
  shift
  run bash -c "cd '$dir' && HOME='$FAKEHOME' $* bash '$HOOK_SRC' 2>&1"
}

# notice_count — how many lines of $output carry the D1 notice.
notice_count() {
  printf '%s\n' "$output" | grep -cF -- "$NOTICE" || true
}

# sql_q <text> — single-quote-escape for an SQL literal (TD-453: the seeders
# must be able to plant a hostname that CARRIES a quote). UNQUOTED expansion
# on purpose: under /bin/bash 3.2 the double-quoted form keeps the backslashes
# literal (`it\'\'s`) and corrupts the SQL — the defect (h1)/(h2)/(h6) found in
# the hook itself; same idiom as core/hooks/shared/session_start.sh.
sql_q() {
  local esc
  esc=${1//\'/\'\'}
  printf '%s' "$esc"
}

# lstart_of <pid> — the pid's start time exactly as the owner-identity writer
# stores it: `ps -p <pid> -o lstart=`, trimmed (cli/src/lib/process-liveness.ts
# getProcessStartTime, the TD-361 parity region).
lstart_of() {
  ps -p "$1" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# spawn_stranger — a live process that is NOT an ancestor of the hook: a
# double-forked sleep, so it is no child of this test either. Sets STRANGER_PID
# (teardown kills it).
spawn_stranger() {
  STRANGER_PID="$( (sleep 600 >/dev/null 2>&1 3>&- & echo $!) )"
  [ -n "$STRANGER_PID" ] || { echo "spawn_stranger: no pid" >&2; return 1; }
}

# seed_row key=value ... — insert one instances row. Keys and defaults:
#   id       (<brief>-<host>)
#   brief    (NULL when the key is absent; `brief=` stores '')
#   phase    (BUILDING)            status   (active)
#   host     ($HOSTNAME_LOCAL)     project  ($PROJECT)
#   mid      (column not written when absent; NULL or a literal id)
#   path     ($REPO, the realpath; NULL for none)
#   lease    (future = now+2h | past = now-2h | NULL | a literal timestamp)
#   owner    (NULL | a pid)
#   started  (auto = lstart_of owner | a literal; only with owner)
#   seen     (now | 'YYYY-MM-DD HH:MM:SS' last_activity_at)
seed_row() {
  local id="" brief="" brief_set=0 phase="BUILDING" istatus="active"
  local host="$HOSTNAME_LOCAL" mid="" mid_set=0 project="$PROJECT" path="$REPO"
  local lease="future" owner="" started="auto" seen="now" kv
  for kv in "$@"; do
    case "$kv" in
      id=*)      id="${kv#id=}" ;;
      brief=*)   brief="${kv#brief=}"; brief_set=1 ;;
      phase=*)   phase="${kv#phase=}" ;;
      status=*)  istatus="${kv#status=}" ;;
      host=*)    host="${kv#host=}" ;;
      mid=*)     mid="${kv#mid=}"; mid_set=1 ;;
      project=*) project="${kv#project=}" ;;
      path=*)    path="${kv#path=}" ;;
      lease=*)   lease="${kv#lease=}" ;;
      owner=*)   owner="${kv#owner=}" ;;
      started=*) started="${kv#started=}" ;;
      seen=*)    seen="${kv#seen=}" ;;
      *) echo "seed_row: unknown key: $kv" >&2; return 1 ;;
    esac
  done
  [ -n "$id" ] || id="${brief}-${host}"

  local brief_sql="NULL" path_sql="NULL" lease_sql owner_sql="NULL"
  local started_sql="NULL" seen_sql="datetime('now')" mid_cols="" mid_vals=""
  [ "$brief_set" = "1" ] && brief_sql="'$(sql_q "$brief")'"
  [ "$path" != "NULL" ] && path_sql="'$(sql_q "$path")'"
  case "$lease" in
    future) lease_sql="datetime('now','+2 hours')" ;;
    past)   lease_sql="datetime('now','-2 hours')" ;;
    NULL)   lease_sql="NULL" ;;
    *)      lease_sql="'$(sql_q "$lease")'" ;;
  esac
  if [ -n "$owner" ] && [ "$owner" != "NULL" ]; then
    case "$owner" in *[!0-9]*) echo "seed_row: owner is not a pid: $owner" >&2; return 1 ;; esac
    owner_sql="$owner"
    [ "$started" = "auto" ] && started="$(lstart_of "$owner")"
    [ -n "$started" ] || { echo "seed_row: no lstart for pid $owner" >&2; return 1; }
    started_sql="'$(sql_q "$started")'"
  fi
  [ "$seen" != "now" ] && seen_sql="'$(sql_q "$seen")'"
  if [ "$mid_set" = "1" ]; then
    mid_cols=", machine_id"
    if [ "$mid" = "NULL" ]; then mid_vals=", NULL"; else mid_vals=", '$(sql_q "$mid")'"; fi
  fi

  sqlite3 "$DB" "
    INSERT INTO instances (id, machine_hostname, project_slug, project_path, current_brief,
                           current_phase, status, last_activity_at, lease_expires_at,
                           owner_pid, owner_started_at$mid_cols)
      VALUES ('$(sql_q "$id")', '$(sql_q "$host")', '$(sql_q "$project")', $path_sql, $brief_sql,
              '$(sql_q "$phase")', '$(sql_q "$istatus")', $seen_sql, $lease_sql,
              $owner_sql, $started_sql$mid_vals);
  "
}

# seed_instance <brief> <status> <hostname> [phase] — the pre-TD-494 seeder:
# a row at this repo's root with a future lease and no owner.
seed_instance() {
  seed_row brief="$1" status="$2" host="$3" phase="${4:-BUILDING}"
}

# seed_brief <brief> <phase> [status-spelling]
# The status spelling is parameterised because the live brain holds MORE THAN
# ONE in-flight spelling ('In Progress' 26 rows, 'InProgress' 4 rows as of
# TD-340). The guard must gate on the STATE, not on one notation of it.
seed_brief() {
  local brief="$1" phase="$2" bstatus="${3:-In Progress}"
  sqlite3 "$DB" "
    INSERT INTO brief_status (project, brief_id, title, status, phase)
      VALUES ('$(sql_q "$PROJECT")', '$(sql_q "$brief")', 't', '$bstatus', '$phase');
  "
}

# -----------------------------------------------------------------------------
# (a) THE PROVING CASE (G-01R closed): active instance row on THIS machine with
#     current_brief=FR-999, brief_status phase=BUILDING -> guard FIRES (exit 1).
#     Pre-fix the guard read the absent CURRENT_SESSION.md, found no brief, and
#     fail-open'd to exit 0. This test would FAIL on the old code, PASS now.
# -----------------------------------------------------------------------------
@test "(a) active instance + BUILDING phase -> guard refuses commit (exit 1)" {
  seed_instance "FR-999" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-999" "BUILDING"

  run_guard
  [ "$status" -eq 1 ]
  [[ "$output" == *"phase guard"* ]]
  [[ "$output" == *"FR-999"* ]]
  [[ "$output" == *"BUILDING"* ]]
}

# -----------------------------------------------------------------------------
# (a2) TD-340 THE HOLE: identical fixture to (a) but the brief's status is
#      spelled 'InProgress' (no space) — a spelling that exists in the live
#      brain (4 rows). The pre-TD-340 guard filtered `status='In Progress'`,
#      which cannot match, so the phase lookup returned EMPTY and the guard
#      FAILED OPEN: exit 0 while a BUILDING brief was mid-hunt.
#
#      This test FAILS on the pre-fix hook (observed: exit 0, no output) and
#      passes on the notation-folded predicate.
# -----------------------------------------------------------------------------
@test "(a2) TD-340: status spelled 'InProgress' -> guard still refuses (no fail-open)" {
  seed_instance "FR-997" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-997" "BUILDING" "InProgress"

  run_guard
  [ "$status" -eq 1 ]
  # `|| return 1`: bash does not fire the ERR trap for a `[[ ]]` compound
  # conditional, and bats-core detects mid-test failures via that trap
  # (errexit is OFF inside a test body). A bare non-final `[[ ... ]]` fails
  # SILENTLY. These TD-340 assertions must be able to fail.
  [[ "$output" == *"phase guard"* ]] || return 1
  [[ "$output" == *"FR-997"* ]] || return 1
  [[ "$output" == *"BUILDING"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (a3) TD-340 notation generalisation: the fold covers case/space/hyphen/
#      underscore, not just the one extra literal 'InProgress'. A FOURTH
#      notation ('in_progress') must also gate. This is the test that fails if
#      someone "fixes" the hole by hardcoding a second literal instead.
# -----------------------------------------------------------------------------
@test "(a3) TD-340: a fourth notation ('in_progress') also gates the guard" {
  seed_instance "FR-996" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-996" "BUILDING" "in_progress"

  run_guard
  [ "$status" -eq 1 ]
  [[ "$output" == *"FR-996"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (a4) TD-340 ASYMMETRY control: the fold must NOT swallow terminal states.
#      A brief whose status is 'Completed' is finished — the phase guard must
#      NOT fire on it even if a stale phase value says BUILDING. This is the
#      negative control that travels the SAME code path as (a2)/(a3): same
#      instance discovery, same SQL, only the status word differs.
# -----------------------------------------------------------------------------
@test "(a4) TD-340: terminal status 'Completed' is NOT folded into in-flight" {
  seed_instance "FR-995" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-995" "BUILDING" "Completed"

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]] || return 1
  [[ "$output" != *"FR-995"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (b) Bypass honored: same fixture, IGRIS_BYPASS_PHASE_GUARD=1 -> exit 0.
#     (The orchestrator's COMMITTING path relies on this — see §8 prereq.)
# -----------------------------------------------------------------------------
@test "(b) IGRIS_BYPASS_PHASE_GUARD=1 -> guard skipped (exit 0)" {
  seed_instance "FR-999" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-999" "BUILDING"

  run_guard "IGRIS_BYPASS_PHASE_GUARD=1"
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
}

# -----------------------------------------------------------------------------
# (c) Phase not gated: brief_status.phase=REVIEWING -> guard does NOT fire.
#     The guard only blocks BUILDING|TESTING.
# -----------------------------------------------------------------------------
@test "(c) phase=REVIEWING -> guard does not fire (exit 0)" {
  seed_instance "FR-999" "active" "$HOSTNAME_LOCAL" "REVIEWING"
  seed_brief "FR-999" "REVIEWING"

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
}

# -----------------------------------------------------------------------------
# (d) Fail-open preserved — no brain DB at all: no instances, no DB ->
#     guard skips silently, exit 0 (the documented fail-open contract).
# -----------------------------------------------------------------------------
@test "(d) no brain DB -> fail-open (exit 0, no error)" {
  rm -f "$DB"
  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
  [[ "$output" != *"phase guard"* ]]
}

# -----------------------------------------------------------------------------
# (e′) TD-494 AC1 — no "newest session file" tier. The pre-TD-494 tier 2 read
#      the NEWEST per-instance session file whenever the registry gave no
#      brief, and gated by whatever brief it named — "newest, not mine", the
#      shape AC1 forbids ((e) and (e2) pinned that tier; this case replaces
#      them). Here the project has one active instance on this machine, but
#      it lives at ANOTHER worktree root and has no owner, so the committing
#      session is unidentified; a session file names a BUILDING brief.
#      -> exit 0 with exactly one notice line; the file is never read.
#      RED on HEAD: tier 2 reads the file and refuses.
# -----------------------------------------------------------------------------
@test "(e′) TD-494: a per-instance file naming a BUILDING brief, no identifiable row -> exit 0 + one notice; the file is never read" {
  seed_brief "FR-999" "BUILDING"
  seed_row id="$ID_U" path="$SANDBOX/elsewhere/$PROJECT" phase="REVIEWING"
  cat > "$INSTANCES_DIR/$ID_U.md" <<MD
## Status
**Mode:** HUNT MODE
**Instance ID:** $ID_U
**Machine:** test (darwin)
**Updated:** 2026-06-17
**Active Brief:** FR-999 (some annotation)
MD

  run_guard
  [ "$status" -eq 0 ] || { echo "expected exit 0 (unidentified, fail open), got $status: [$output]"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || return 1
  [[ "$output" != *"FR-999"* ]] || { echo "the session file was read: [$output]"; return 1; }
  [ "$(notice_count)" = "1" ] || { echo "expected exactly one notice line: [$output]"; return 1; }
}

# -----------------------------------------------------------------------------
# (f) Machine disambiguation: a BUILDING instance row exists but for a DIFFERENT
#     machine_hostname. The local-machine query must NOT pick the foreign row ->
#     no brief discovered -> guard skips, exit 0. Proves the guard won't gate on
#     another machine's session.
# -----------------------------------------------------------------------------
@test "(f) foreign-machine BUILDING instance -> not selected (exit 0)" {
  seed_instance "FR-888" "active" "some-other-host" "BUILDING"
  seed_brief "FR-888" "BUILDING"

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
  [[ "$output" != *"FR-888"* ]]
}

# -----------------------------------------------------------------------------
# (f2) Disambiguation positive control: same foreign row PLUS a local-machine
#      active row in BUILDING -> the local row IS selected -> guard FIRES.
#      Proves (f)'s exit-0 was the foreign-row exclusion, not a dead query.
# -----------------------------------------------------------------------------
@test "(f2) local + foreign instance rows -> local selected, guard fires" {
  seed_instance "FR-888" "active" "some-other-host" "BUILDING"
  seed_instance "FR-777" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-888" "BUILDING"
  seed_brief "FR-777" "BUILDING"

  run_guard
  [ "$status" -eq 1 ]
  [[ "$output" == *"FR-777"* ]]
  [[ "$output" != *"FR-888"* ]]
}

# -----------------------------------------------------------------------------
# (f3) Stale instance excluded: a BUILDING row on THIS machine but status='stale'
#      (the registry reaper marks >45min rows stale) -> NOT selected (query
#      filters status='active') -> guard skips, exit 0.
# -----------------------------------------------------------------------------
@test "(f3) stale local instance (status!=active) -> not selected (exit 0)" {
  seed_instance "FR-666" "stale" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-666" "BUILDING"

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
}

# -----------------------------------------------------------------------------
# BR-100 — the machine IDENTITY replaces the bare hostname in tier 1.
#   (g1) a row under a PRIOR hostname (an alias, NULL machine_id) is found;
#   (g2) a row with MY machine_id under a foreign hostname is found;
#   (g3) a row with a FOREIGN machine_id under MY hostname is NOT found;
#   (g4) a brain WITHOUT the column falls back to hostname-in-aliases;
#   (g5) G10 self-negative: a hook copy with the identity section removed
#        flips (g1) back to exit 0 — proves the section is what makes it fire.
# TD-494: the same machine predicate filters every identification tier.
# -----------------------------------------------------------------------------

# add_machine_id_column — the instances v5 shape. The default fixture already
# carries the column (TD-494), so this only adds it to a pre-v5 table; it is
# kept so each g/h case states the shape it needs.
add_machine_id_column() {
  case "$(sqlite3 "$DB" "PRAGMA table_info(instances);")" in
    *'|machine_id|'*) return 0 ;;
  esac
  sqlite3 "$DB" "ALTER TABLE instances ADD COLUMN machine_id TEXT;"
}

# seed_identity <id> [alias...] — config.json `machine` block in the fake HOME.
seed_identity() {
  local mid="$1"; shift
  local aliases="" a
  for a in "$@"; do
    [ -n "$aliases" ] && aliases="$aliases, "
    aliases="$aliases\"$a\""
  done
  printf '{"machine":{"id":"%s","aliases":[%s]}}\n' "$mid" "$aliases" > "$FAKEHOME/.igris/config.json"
}

# seed_instance_id <brief> <status> <hostname> <machine_id-or-NULL> [phase] [last_activity_at]
# The optional timestamp orders rows for the pre-TD-494 `ORDER BY
# last_activity_at DESC LIMIT 1` (TD-453 h3: the injected predicate would
# surface the NEWER foreign row over my older one).
seed_instance_id() {
  seed_row brief="$1" status="$2" host="$3" mid="$4" phase="${5:-BUILDING}" seen="${6:-now}"
}

@test "(g1) BR-100: a row under a PRIOR hostname (alias, NULL id) is this machine -> guard fires" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine" "MacBookAir"
  seed_instance_id "FR-555" "active" "MacBookAir" "NULL" "BUILDING"
  seed_brief "FR-555" "BUILDING"

  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-555"* ]] || return 1
}

@test "(g2) BR-100: a row with MY machine_id under a foreign hostname is this machine -> guard fires" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine"
  seed_instance_id "FR-444" "active" "renamed-elsewhere" "id-mine" "BUILDING"
  seed_brief "FR-444" "BUILDING"

  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-444"* ]] || return 1
}

@test "(g3) BR-100: a row with a FOREIGN machine_id under MY hostname is NOT this machine -> exit 0" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine" "$HOSTNAME_LOCAL"
  seed_instance_id "FR-333" "active" "$HOSTNAME_LOCAL" "id-theirs" "BUILDING"
  seed_brief "FR-333" "BUILDING"

  run_guard
  [ "$status" -eq 0 ] || return 1
  if printf '%s\n' "$output" | grep -q 'refusing commit'; then return 1; fi
}

@test "(g4) BR-100: a brain WITHOUT the column falls back to hostname-in-aliases -> alias row still found" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  # The pre-v5 brain: every TD-494 column, but no machine_id.
  create_instances_table no-machine-id
  case "$(sqlite3 "$DB" "PRAGMA table_info(instances);")" in
    *'|machine_id|'*) echo "machine_id column still present"; return 1 ;;
  esac
  seed_identity "id-mine" "MacBookAir"
  seed_instance "FR-222" "active" "MacBookAir" "BUILDING"
  seed_brief "FR-222" "BUILDING"

  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-222"* ]] || return 1
}

@test "(g5) G10 self-negative: a hook copy WITHOUT the identity section no longer finds the alias row (exit 0)" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine" "MacBookAir"
  seed_instance_id "FR-111" "active" "MacBookAir" "NULL" "BUILDING"
  seed_brief "FR-111" "BUILDING"

  # Same arrangement as (g1) fires on the real hook…
  run_guard
  [ "$status" -eq 1 ] || return 1

  # …and a copy with the identity section deleted reverts to the live-hostname-only query.
  local mutant="$SANDBOX/pre-commit.no-identity"
  sed '/# BR-100 identity: begin/,/# BR-100 identity: end/d' "$HOOK_SRC" > "$mutant"
  grep -q 'IDENTITY_LINE' "$mutant" && return 1   # the section really is gone
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' bash '$mutant' 2>&1"
  [ "$status" -eq 0 ] || return 1
}

# -----------------------------------------------------------------------------
# TD-453 — a hostname, alias or machine id that CARRIES a quote reaches the
# tier-1 query escaped (three sites in the hook: HOSTNAME_SQL, every alias,
# MACHINE_ID_SQL). The hook discards sqlite3's stderr (`2>/dev/null`), so "the
# query errored" is NOT observable; the witness is two-directional and
# behavioural instead. A no-escape MUTANT of the hook — $HOOK_SRC with the
# three escapes replaced by their raw forms, each replacement proven landed —
# reads a quoted alias / hostname / id row as "no active brief" (exit 0, the
# false fail-open: h4, h4c, h4d) AND lets an injected alias match a FOREIGN
# row (exit 1: h4b), while the real hook does neither (h1–h3). h5 is the
# control: a CLEAN name fires identically on both, so h4's red is the quote and
# not the arrangement. The repo hook is never edited (the TD388_WRAPPER_SRC
# idiom); bash 3.2 throughout.
# -----------------------------------------------------------------------------

# stub_hostname <name> — a PATH-first `hostname` printing <name>. Pass
# "PATH='$SANDBOX/stubbin:$PATH'" to run_guard (it accepts env prefixes).
stub_hostname() {
  mkdir -p "$SANDBOX/stubbin"
  { printf '#!/bin/bash\n'; printf 'printf "%%s\\n" %q\n' "$1"; } > "$SANDBOX/stubbin/hostname"
  chmod +x "$SANDBOX/stubbin/hostname"
}

# The three tier-1 escaping sites (post-TD-453 form: UNQUOTED assignment —
# the double-quoted `"${x//\'/\'\'}"` keeps the backslashes literal under
# /bin/bash 3.2), verbatim, and their raw forms.
A_ESC="alias_sql=\${alias//\\'/\\'\\'}"
A_RAW="alias_sql=\$alias"
M_ESC="MACHINE_ID_SQL=\${MACHINE_ID//\\'/\\'\\'}"
M_RAW="MACHINE_ID_SQL=\$MACHINE_ID"
H_ESC="HOSTNAME_SQL=\${HOSTNAME_LOCAL//\\'/\\'\\'}"
H_RAW="HOSTNAME_SQL=\$HOSTNAME_LOCAL"

# count_sites <file> <p1> <p2> <p3> — fixed-string line count over the three patterns.
count_sites() {
  local f="$1" n=0 p
  shift
  for p in "$@"; do
    n=$((n + $(grep -cF -- "$p" "$f" || true)))
  done
  echo "$n"
}

# build_no_escape_mutant — $SANDBOX/pre-commit.no-escape. Asserts each of the
# three replacements LANDED (escaped forms 3 -> 0, raw forms 0 -> 3;
# test_standards: a mutation that did not land is a meaningless green).
build_no_escape_mutant() {
  MUTANT="$SANDBOX/pre-commit.no-escape"
  [ "$(count_sites "$HOOK_SRC" "$A_ESC" "$M_ESC" "$H_ESC")" = "3" ] || { echo "hook: expected 3 escaped sites" >&2; return 1; }
  [ "$(count_sites "$HOOK_SRC" "$A_RAW" "$M_RAW" "$H_RAW")" = "0" ] || { echo "hook: expected 0 raw sites" >&2; return 1; }
  python3 - "$HOOK_SRC" "$MUTANT" "$A_ESC" "$A_RAW" "$M_ESC" "$M_RAW" "$H_ESC" "$H_RAW" <<'PY' || return 1
import sys
src, dst = sys.argv[1], sys.argv[2]
pairs = list(zip(sys.argv[3::2], sys.argv[4::2]))
text = open(src, encoding="utf-8").read()
for esc, raw in pairs:
    if text.count(esc) != 1:
        sys.exit("site not found exactly once: " + esc)
    text = text.replace(esc, raw)
open(dst, "w", encoding="utf-8").write(text)
PY
  [ "$(count_sites "$MUTANT" "$A_ESC" "$M_ESC" "$H_ESC")" = "0" ] || { echo "mutant: escaped sites remain" >&2; return 1; }
  [ "$(count_sites "$MUTANT" "$A_RAW" "$M_RAW" "$H_RAW")" = "3" ] || { echo "mutant: raw sites missing" >&2; return 1; }
  return 0
}

run_mutant() {
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' $* bash '$MUTANT' 2>&1"
}

@test "(h1) TD-453: an ALIAS carrying a quote (it's;old-host) still finds my NULL-id row -> exit 1" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  add_machine_id_column
  seed_identity "id-mine" "it's;old-host"
  seed_instance_id "FR-451" "active" "it's;old-host" "NULL" "BUILDING"
  seed_brief "FR-451" "BUILDING"
  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-451"* ]] || return 1
}

@test "(h2) TD-453: a LIVE hostname carrying a quote (it's;host, PATH stub, no config.json) still finds my row -> exit 1" {
  stub_hostname "it's;host"
  seed_instance "FR-452" "active" "it's;host" "BUILDING"
  seed_brief "FR-452" "BUILDING"
  run_guard "PATH='$SANDBOX/stubbin:$PATH'"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-452"* ]] || return 1
}

# (h3)'s arrangement: my OLDER row under a clean alias, a NEWER foreign row
# under a foreign id, both briefs BUILDING, and an injected alias in config.
# The real hook must name MINE (the query ran, the injection widened nothing);
# a query that errored would name nothing (exit 0), and the no-escape mutant
# names the FOREIGN row (the injected predicate admits it).
# TD-494: the foreign row is also OWNED by this test's own process, an ancestor
# of the hook. On the newest-row hook the mutant picks it for being newer; on
# the S1–S3 hook the mutant picks it through S2. The real hook carries the
# machine predicate in every tier, so S2 never sees it and S3 finds my row alone.
seed_h3() {
  add_machine_id_column
  seed_identity "id-mine" "clean-host" "x') OR ('1'='1"
  seed_instance_id "FR-456" "active" "clean-host" "NULL" "BUILDING" "2026-01-01 00:00:00"
  seed_row brief="FR-453" host="some-other-host" mid="id-theirs" seen="2026-06-01 00:00:00" owner="$$"
  seed_brief "FR-456" "BUILDING"
  seed_brief "FR-453" "BUILDING"
}

@test "(h3) TD-453: an INJECTED alias (x') OR ('1'='1) widens nothing — the real hook names MY row, not the newer FOREIGN one" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  seed_h3
  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-456"* ]] || return 1
  [[ "$output" != *"FR-453"* ]] || return 1
}

@test "(h4) TD-453 RED: the no-escape MUTANT (3 sites raw, each proven landed) reads h1's quoted alias as 'no active brief' -> exit 0; the real hook exits 1" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  add_machine_id_column
  seed_identity "id-mine" "it's;old-host"
  seed_instance_id "FR-451" "active" "it's;old-host" "NULL" "BUILDING"
  seed_brief "FR-451" "BUILDING"
  run_guard
  [ "$status" -eq 1 ] || return 1
  run_mutant
  [ "$status" -eq 0 ] || return 1
  [[ "$output" != *"FR-451"* ]] || return 1
}

@test "(h4b) TD-453 RED: the no-escape MUTANT lets h3's injected alias admit the newer FOREIGN row (names FR-453); the real hook names mine (FR-456)" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  seed_h3
  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-456"* ]] || return 1
  run_mutant
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-453"* ]] || return 1
  [[ "$output" != *"FR-456"* ]] || return 1
}

@test "(h4c) TD-453 RED: the no-escape MUTANT reads h2's quoted LIVE hostname as 'no active brief' -> exit 0; the real hook exits 1" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  stub_hostname "it's;host"
  seed_instance "FR-452" "active" "it's;host" "BUILDING"
  seed_brief "FR-452" "BUILDING"
  run_guard "PATH='$SANDBOX/stubbin:$PATH'"
  [ "$status" -eq 1 ] || return 1
  run_mutant "PATH='$SANDBOX/stubbin:$PATH'"
  [ "$status" -eq 0 ] || return 1
}

@test "(h4d) TD-453 RED: a MACHINE ID carrying a quote (id'mine) — real hook finds my id row (exit 1); the no-escape MUTANT reads 'no active brief' (exit 0)" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  add_machine_id_column
  seed_identity "id'mine"
  seed_instance_id "FR-454" "active" "some-other-host" "id'mine" "BUILDING"
  seed_brief "FR-454" "BUILDING"
  run_guard
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-454"* ]] || return 1
  run_mutant
  [ "$status" -eq 0 ] || return 1
}

@test "(h5) TD-453 control: a CLEAN alias fires on the real hook AND on the no-escape mutant (exit 1 both) — h4's red is the quote" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not available"
  build_no_escape_mutant || return 1
  add_machine_id_column
  seed_identity "id-mine" "old-host"
  seed_instance_id "FR-455" "active" "old-host" "NULL" "BUILDING"
  seed_brief "FR-455" "BUILDING"
  run_guard
  [ "$status" -eq 1 ] || return 1
  run_mutant
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-455"* ]] || return 1
}

@test "(h6) TD-453: a PROJECT (repo basename) carrying a quote (it's-proj) reaches both tier-1 queries escaped -> exit 1" {
  # PROJECT_SQL is built at two sites (the instances query and the brief_status
  # phase query); a fail-open at either reads "no active brief" / no phase.
  # TD-494: the row's project_path (the worktree-root key) carries the quote too.
  PROJECT="it's-proj"
  QREPO="$SANDBOX/$PROJECT"
  mkdir -p "$QREPO"
  git -C "${QREPO:?}" init -q
  REPO="$QREPO"   # the seeders key project_path on $REPO
  seed_instance "FR-457" "active" "$HOSTNAME_LOCAL" "BUILDING"
  seed_brief "FR-457" "BUILDING"
  run bash -c "cd \"$QREPO\" && HOME='$FAKEHOME' bash '$HOOK_SRC' 2>&1"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"FR-457"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (e3′) TD-468 witness, moved to the DB tier by TD-494 (the session-file tier
#       that (e3) exercised is deleted): the identified row's current_brief is
#       a LETTERED id, `FR-999a`, BUILDING, and `FR-999` does not exist. The
#       guard must look up the child, never a truncated parent -> exit 1
#       naming FR-999a.
# -----------------------------------------------------------------------------
@test "(e3′) TD-468: the identified row names a lettered brief (FR-999a BUILDING, FR-999 absent) -> guard fires naming FR-999a" {
  seed_row id="$ID_A" brief="FR-999a"
  seed_brief "FR-999a" "BUILDING"

  run_guard
  [ "$status" -eq 1 ] || { echo "expected exit 1 (guard fires on FR-999a), got $status; output: [$output]"; return 1; }
  [[ "$output" == *"brief: FR-999a"* ]] || { echo "child id not resolved: [$output]"; return 1; }
  [[ "$output" == *"BUILDING"* ]] || return 1
}

# =============================================================================
# TD-494 — the guard gates by the COMMITTING session's brief.
# =============================================================================

# -----------------------------------------------------------------------------
# (s3) AC1/AC2 — two sessions in two worktrees of one repo on one machine.
#      A (worktree a) holds X=FR-921 in BUILDING; B (worktree b) holds
#      Y=FR-922 in REVIEWING and is MORE RECENT. Neither row has an owner, so
#      only the worktree root (S3) can tell them apart.
#      Commit from a -> refused, naming X and A's session.
#      Commit from b -> allowed.
#      RED on HEAD: the newest row (B, REVIEWING) gates both, so a commit from
#      a is allowed.
# -----------------------------------------------------------------------------
make_worktrees() {
  git -C "${REPO:?}" -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit -q --no-verify --allow-empty -m init || return 1
  mkdir -p "${SANDBOX:?}/a" "${SANDBOX:?}/b"
  WT_A="${SANDBOX:?}/a/$PROJECT"
  WT_B="${SANDBOX:?}/b/$PROJECT"
  git -C "${REPO:?}" -c core.hooksPath=/dev/null worktree add -q -b wt-a "${WT_A:?}" || return 1
  git -C "${REPO:?}" -c core.hooksPath=/dev/null worktree add -q -b wt-b "${WT_B:?}" || return 1
  [ "$(git -C "${WT_A:?}" rev-parse --show-toplevel)" = "$WT_A" ] || { echo "worktree a toplevel is not $WT_A"; return 1; }
  [ "$(git -C "${WT_B:?}" rev-parse --show-toplevel)" = "$WT_B" ] || { echo "worktree b toplevel is not $WT_B"; return 1; }
}

@test "(s3) TD-494 AC2: two worktrees, A=FR-921 BUILDING, B=FR-922 REVIEWING and newer -> a refused naming A; b allowed" {
  make_worktrees || return 1
  seed_row id="$ID_A" brief="FR-921" path="$WT_A" seen="2026-01-01 00:00:00"
  seed_row id="$ID_B" brief="FR-922" path="$WT_B" seen="2026-06-01 00:00:00" phase="REVIEWING"
  seed_brief "FR-921" "BUILDING"
  seed_brief "FR-922" "REVIEWING"

  run_guard_in "$WT_A"
  [ "$status" -eq 1 ] || { echo "commit from a: expected exit 1 (A's FR-921 BUILDING), got $status: [$output]"; return 1; }
  [[ "$output" == *"FR-921"* ]] || return 1
  [[ "$output" != *"FR-922"* ]] || return 1
  [[ "$output" == *"session: ${ID_A:0:8}"* ]] || { echo "A's session not named: [$output]"; return 1; }

  run_guard_in "$WT_B"
  [ "$status" -eq 0 ] || { echo "commit from b: expected exit 0 (B's FR-922 REVIEWING), got $status: [$output]"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || return 1
  [ "$(notice_count)" = "0" ] || { echo "b is identified; no notice expected: [$output]"; return 1; }
}

# -----------------------------------------------------------------------------
# (s2) AC1 — two live sessions at ONE path (the shared main checkout). A is
#      owned by this test's own process ($$, an ancestor of the hook) with its
#      real start time; B is owned by a live process that is NOT an ancestor,
#      and B is newer. S3 is ambiguous here, so only S2 can identify A.
#      (s2)  A=FR-901 BUILDING, B=FR-902 REVIEWING -> refused by A's brief.
#      (s2b) the briefs swapped -> allowed.
#      RED on HEAD: the newest row (B) gates the commit in both directions.
# -----------------------------------------------------------------------------
@test "(s2) TD-494: shared checkout, A owned by an ancestor (FR-901 BUILDING), B newer (FR-902 REVIEWING) -> refused by A's brief" {
  spawn_stranger || return 1
  seed_row id="$ID_A" brief="FR-901" owner="$$" seen="2026-01-01 00:00:00"
  seed_row id="$ID_B" brief="FR-902" owner="$STRANGER_PID" seen="2026-06-01 00:00:00" phase="REVIEWING"
  seed_brief "FR-901" "BUILDING"
  seed_brief "FR-902" "REVIEWING"

  run_guard
  [ "$status" -eq 1 ] || { echo "expected exit 1 (A's FR-901 BUILDING), got $status: [$output]"; return 1; }
  [[ "$output" == *"FR-901"* ]] || return 1
  [[ "$output" != *"FR-902"* ]] || return 1
  [[ "$output" == *"session: ${ID_A:0:8}"* ]] || { echo "A's session not named: [$output]"; return 1; }
  [[ "$output" == *"owner process"* ]] || { echo "not identified by owner process: [$output]"; return 1; }
}

@test "(s2b) TD-494: shared checkout, briefs swapped (A FR-904 REVIEWING, newer B FR-903 BUILDING) -> allowed" {
  spawn_stranger || return 1
  seed_row id="$ID_A" brief="FR-904" owner="$$" seen="2026-01-01 00:00:00" phase="REVIEWING"
  seed_row id="$ID_B" brief="FR-903" owner="$STRANGER_PID" seen="2026-06-01 00:00:00"
  seed_brief "FR-904" "REVIEWING"
  seed_brief "FR-903" "BUILDING"

  run_guard
  [ "$status" -eq 0 ] || { echo "expected exit 0 (A's FR-904 REVIEWING), got $status: [$output]"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || return 1
  [[ "$output" != *"FR-903"* ]] || return 1
  [ "$(notice_count)" = "0" ] || { echo "A is identified; no notice expected: [$output]"; return 1; }
}

# -----------------------------------------------------------------------------
# (s2m) mutation control for S2's start-time check. One row: owner_pid=$$ (an
#       ancestor) but a WRONG owner_started_at — the shape of a recycled pid —
#       FR-931 BUILDING, expired lease. The real hook must not identify it
#       (exit 0 + one notice). A copy of the hook with the lstart block
#       (`# TD-494 S2 lstart: begin` .. `end`) deleted, the deletion proven
#       landed, identifies it by pid alone and refuses naming FR-931 — so the
#       compare is what keeps a recycled pid out.
#       RED on HEAD: HEAD takes the row because it is the newest (exit 1).
# -----------------------------------------------------------------------------
S2_BEGIN="# TD-494 S2 lstart: begin"
S2_END="# TD-494 S2 lstart: end"

# build_no_lstart_mutant — $SANDBOX/pre-commit.no-lstart, the S2 lstart block
# deleted. Asserts the block exists once, holds an lstart read or compare
# between its markers, and is gone from the copy.
build_no_lstart_mutant() {
  MUTANT="$SANDBOX/pre-commit.no-lstart"
  [ "$(grep -cF -- "$S2_BEGIN" "$HOOK_SRC" || true)" = "1" ] || { echo "hook: expected one '$S2_BEGIN' marker" >&2; return 1; }
  [ "$(grep -cF -- "$S2_END" "$HOOK_SRC" || true)" = "1" ] || { echo "hook: expected one '$S2_END' marker" >&2; return 1; }
  awk -v b="$S2_BEGIN" -v e="$S2_END" 'index($0, e) { f = 0 } f { print } index($0, b) { f = 1 }' "$HOOK_SRC" \
    | grep -q 'lstart' || { echo "hook: the S2 lstart block holds no lstart read/compare" >&2; return 1; }
  awk -v b="$S2_BEGIN" -v e="$S2_END" 'index($0, b) { f = 1 } !f { print } index($0, e) { f = 0 }' "$HOOK_SRC" > "$MUTANT"
  [ "$(grep -cF -- "$S2_BEGIN" "$MUTANT" || true)" = "0" ] || { echo "mutant: the block is still there" >&2; return 1; }
  [ "$(grep -cF -- "$S2_END" "$MUTANT" || true)" = "0" ] || { echo "mutant: the end marker is still there" >&2; return 1; }
  [ "$(wc -l < "$MUTANT")" -lt "$(($(wc -l < "$HOOK_SRC") - 2))" ] || { echo "mutant: no line between the markers was removed" >&2; return 1; }
  return 0
}

@test "(s2m) TD-494 mutation control: owner_pid = this test's pid with a WRONG start time is not identified (exit 0 + notice); the hook copy without the lstart block refuses on it" {
  seed_row id="$ID_C" brief="FR-931" owner="$$" started="Thu Jan  1 00:00:00 1970" lease="past"
  seed_brief "FR-931" "BUILDING"

  run_guard
  [ "$status" -eq 0 ] || { echo "real hook: expected exit 0 (pid matches, start time does not), got $status: [$output]"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || return 1
  [ "$(notice_count)" = "1" ] || { echo "expected exactly one notice line: [$output]"; return 1; }

  build_no_lstart_mutant || return 1
  run_mutant
  [ "$status" -eq 1 ] || { echo "mutant: expected exit 1 (pid-only match), got $status: [$output]"; return 1; }
  [[ "$output" == *"FR-931"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (s1) AC1 — IGRIS_INSTANCE_ID wins, and is never second-guessed.
#      (s1)  the variable names A (FR-911 BUILDING, no owner, older) while B
#            (FR-912 REVIEWING, newer) is owned by the NEAREST ancestor ->
#            A's verdict: refused, identified by IGRIS_INSTANCE_ID.
#      (s1b) a well-shaped id naming NO row -> unidentified: exit 0 and a
#            notice naming the id; it does not fall through to S2, although
#            the row S2 would pick (B, owned by $$) is BUILDING.
#      (s1c) an id naming a FOREIGN-machine row -> the same.
#      (s1d) an id that does not parse falls through to S2: B (owned by $$,
#            FR-915 BUILDING) refuses although a newer row (C, elsewhere,
#            REVIEWING) exists.
#      RED on HEAD: the variable is unread and the newest row decides.
# -----------------------------------------------------------------------------
@test "(s1) TD-494: IGRIS_INSTANCE_ID=A gives A's verdict (FR-911 BUILDING) though B is the nearest ancestor and newer" {
  seed_row id="$ID_A" brief="FR-911" seen="2026-01-01 00:00:00"
  seed_row id="$ID_B" brief="FR-912" owner="$$" seen="2026-06-01 00:00:00" phase="REVIEWING"
  seed_brief "FR-911" "BUILDING"
  seed_brief "FR-912" "REVIEWING"

  run_guard "IGRIS_INSTANCE_ID='$ID_A'"
  [ "$status" -eq 1 ] || { echo "expected exit 1 (A's FR-911 BUILDING), got $status: [$output]"; return 1; }
  [[ "$output" == *"FR-911"* ]] || return 1
  [[ "$output" != *"FR-912"* ]] || return 1
  [[ "$output" == *"session: ${ID_A:0:8}"* ]] || { echo "A's session not named: [$output]"; return 1; }
  [[ "$output" == *"IGRIS_INSTANCE_ID"* ]] || { echo "not identified by IGRIS_INSTANCE_ID: [$output]"; return 1; }
}

@test "(s1b) TD-494: IGRIS_INSTANCE_ID naming no row -> exit 0 + a notice naming the id; no fall-through to S2's BUILDING row" {
  seed_row id="$ID_B" brief="FR-913" owner="$$"
  seed_brief "FR-913" "BUILDING"

  run_guard "IGRIS_INSTANCE_ID='$ID_ABSENT'"
  [ "$status" -eq 0 ] || { echo "expected exit 0 (named session absent; S2 must not be consulted), got $status: [$output]"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || return 1
  [ "$(notice_count)" = "1" ] || { echo "expected exactly one notice line: [$output]"; return 1; }
  printf '%s\n' "$output" | grep -F -- "$NOTICE" | grep -qF -- "$ID_ABSENT" \
    || { echo "the notice does not name the id: [$output]"; return 1; }
}

@test "(s1c) TD-494: IGRIS_INSTANCE_ID naming a FOREIGN-machine row -> exit 0 + a notice naming the id; no fall-through to S2's BUILDING row" {
  seed_row id="$ID_F" brief="FR-914" host="some-other-host"
  seed_row id="$ID_B" brief="FR-913" owner="$$"
  seed_brief "FR-914" "BUILDING"
  seed_brief "FR-913" "BUILDING"

  run_guard "IGRIS_INSTANCE_ID='$ID_F'"
  [ "$status" -eq 0 ] || { echo "expected exit 0 (named session is another machine's), got $status: [$output]"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || return 1
  [[ "$output" != *"FR-914"* ]] || return 1
  [ "$(notice_count)" = "1" ] || { echo "expected exactly one notice line: [$output]"; return 1; }
  printf '%s\n' "$output" | grep -F -- "$NOTICE" | grep -qF -- "$ID_F" \
    || { echo "the notice does not name the id: [$output]"; return 1; }
}

@test "(s1d) TD-494: an unparseable IGRIS_INSTANCE_ID falls through to S2 (B owned by this test's process, FR-915 BUILDING) though a newer row exists" {
  seed_row id="$ID_B" brief="FR-915" owner="$$" seen="2026-01-01 00:00:00"
  seed_row id="$ID_C" brief="FR-916" path="$SANDBOX/elsewhere/$PROJECT" seen="2026-06-01 00:00:00" phase="REVIEWING"
  seed_brief "FR-915" "BUILDING"
  seed_brief "FR-916" "REVIEWING"

  run_guard "IGRIS_INSTANCE_ID='bad id;x'"
  [ "$status" -eq 1 ] || { echo "expected exit 1 (S2 identifies B, FR-915 BUILDING), got $status: [$output]"; return 1; }
  [[ "$output" == *"FR-915"* ]] || return 1
  [[ "$output" == *"session: ${ID_B:0:8}"* ]] || { echo "B's session not named: [$output]"; return 1; }
  [[ "$output" == *"owner process"* ]] || { echo "not identified by owner process: [$output]"; return 1; }
}

# -----------------------------------------------------------------------------
# (u1) AC3 / D1 — two live rows at this root, neither owned by an ancestor
#      (one has no owner, one is owned by a live stranger), both BUILDING.
#      The session cannot be identified -> exit 0 and EXACTLY ONE notice line.
#      RED on HEAD: the newest row's BUILDING brief refuses (exit 1).
# (u2) AC3 / D1 control — no instance row of THIS project (one of another
#      project sits at the same root, BUILDING) -> exit 0 and NO notice: a
#      plain-git consumer stays silent. Green on HEAD by design.
# -----------------------------------------------------------------------------
@test "(u1) TD-494 D1: two live rows at the root, none an ancestor -> exit 0 and exactly one notice line" {
  spawn_stranger || return 1
  seed_row id="$ID_A" brief="FR-941" seen="2026-01-01 00:00:00"
  seed_row id="$ID_B" brief="FR-942" owner="$STRANGER_PID" seen="2026-06-01 00:00:00"
  seed_brief "FR-941" "BUILDING"
  seed_brief "FR-942" "BUILDING"

  run_guard
  [ "$status" -eq 0 ] || { echo "expected exit 0 (unidentified, fail open), got $status: [$output]"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || return 1
  [ "$(notice_count)" = "1" ] || { echo "expected exactly one notice line, got $(notice_count): [$output]"; return 1; }
}

@test "(u2) TD-494 D1 control: no instance row of this project -> exit 0 and no notice" {
  seed_row id="$ID_A" brief="FR-951" project="otherproj"
  seed_brief "FR-951" "BUILDING"

  run_guard
  [ "$status" -eq 0 ] || { echo "expected exit 0, got $status: [$output]"; return 1; }
  [[ "$output" != *"refusing commit"* ]] || return 1
  [ "$(notice_count)" = "0" ] || { echo "a project with no instances must stay silent: [$output]"; return 1; }
}

# -----------------------------------------------------------------------------
# (n1) AC4 — one "no brief" value. The identified row's current_brief is, in
#      turn, NULL, '', 'none', 'None' and ' none '; brief_status holds
#      BUILDING rows literally named `none` and `None`, so any spelling the
#      guard fails to normalise is looked up and refuses. Every spelling must
#      read as "no brief" -> exit 0.
#      RED on HEAD: it reads 'none', 'None' and ' none ' (whitespace stripped)
#      as brief ids, matches the rows and refuses.
# -----------------------------------------------------------------------------
@test "(n1) TD-494 AC4: current_brief NULL, '', 'none', 'None', ' none ' all mean no brief -> exit 0" {
  seed_brief "none" "BUILDING"
  seed_brief "None" "BUILDING"
  local fails="" v
  for v in NULL "" "none" "None" " none "; do
    sqlite3 "$DB" "DELETE FROM instances;"
    if [ "$v" = "NULL" ]; then
      seed_row id="$ID_A" || return 1
    else
      seed_row id="$ID_A" brief="$v" || return 1
    fi
    run_guard
    if [ "$status" -ne 0 ] || [[ "$output" == *"refusing commit"* ]]; then
      fails="$fails [$v]"
    fi
  done
  [ -z "$fails" ] || { echo "refused for current_brief:$fails"; return 1; }
}

# -----------------------------------------------------------------------------
# (m1) AC7 — the refusal is mode-neutral and says what it decided on: the
#      brief, the phase, the session it identified (first 8 characters of the
#      id, and how) and the project. It names no reviewing agent and no
#      orchestrator ownership.
#      RED on HEAD: the refusal says "the orchestrator owns COMMITTING —
#      sentinel + warden must run first" and names no session.
# -----------------------------------------------------------------------------
@test "(m1) TD-494 AC7: the refusal names brief, phase, session and project, and is mode-neutral" {
  seed_row id="$ID_M" brief="FR-961"
  seed_brief "FR-961" "BUILDING"

  run_guard
  [ "$status" -eq 1 ] || { echo "expected exit 1, got $status: [$output]"; return 1; }
  [[ "$output" == *"PI-004 phase guard: refusing commit"* ]] || return 1
  [[ "$output" != *"sentinel"* ]] || { echo "names sentinel: [$output]"; return 1; }
  [[ "$output" != *"warden"* ]] || { echo "names warden: [$output]"; return 1; }
  [[ "$output" != *"orchestrator owns"* ]] || { echo "names orchestrator ownership: [$output]"; return 1; }
  [[ "$output" == *"brief: FR-961"* ]] || { echo "brief not named: [$output]"; return 1; }
  [[ "$output" == *"phase: BUILDING"* ]] || { echo "phase not named: [$output]"; return 1; }
  [[ "$output" == *"session: ${ID_M:0:8} (identified by"* ]] || { echo "session not named: [$output]"; return 1; }
  [[ "$output" == *"project: $PROJECT"* ]] || { echo "project not named: [$output]"; return 1; }
}
