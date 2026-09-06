#!/usr/bin/env bats

# phase_guard.test.bash — FR-186 / G-01R. Tests for the re-pointed PI-004
# phase guard in scripts/git-hooks/pre-commit.
#
# What changed (G-01R): the guard used to read the Active Brief from the
# retired session/CURRENT_SESSION.md. FR-133 archived that file, so the grep
# returned empty and the guard went silently inert. The fix re-points
# brief discovery to the brain `instances` registry (machine-scoped, freshest
# activity), with a per-instance session-file fallback, then a legacy
# CURRENT_SESSION.md fallback. The gate decision still uses brief_status.phase
# (refuse on BUILDING|TESTING) — only the brief-DISCOVERY source changed.
#
# Test isolation
# --------------
# The hook hardcodes $HOME/.igris/memory/knowledge.db and
# $HOME/.igris/projects/<project>/session/... — so a fresh HOME scratch dir
# isolates the whole fixture. The hook derives PROJECT from
# basename(git rev-parse --show-toplevel); each test runs the hook from inside
# a sandbox git repo whose basename we control, and seeds the instances /
# brief_status rows for THAT project slug + THIS machine's hostname.
#
# Why exit code is the contract: when the guard fires it `exit 1` at the top of
# the hook (before any validator). When it does NOT fire, the hook proceeds;
# with no enum/lockfile/harness/skill files staged the remaining validators are
# all skipped and the hook exits 0. So: guard-fires <=> exit 1, otherwise exit 0.
#
# Past mistakes to avoid (forger memory)
# --------------------------------------
# Memory ID 287: macOS system sqlite3 can't load vec0/FTS5 — we only create
# plain instances + brief_status tables (no vec0 / FTS5).
# Memory ID 29: cover the edge verdicts (fail-open tiers, machine
# disambiguation), not just the happy path.

load test_helper

HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/pre-commit"

setup() {
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v git >/dev/null 2>&1 || skip "git not available"

  HOSTNAME_LOCAL="$(hostname)"

  # Sandbox scratch dir. The project slug is the repo's basename — we name the
  # repo 'gproj' so PROJECT=gproj deterministically.
  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/pg.XXXXXX")"
  FAKEHOME="$SANDBOX/fakehome"
  mkdir -p "$FAKEHOME/.igris/memory"
  DB="$FAKEHOME/.igris/memory/knowledge.db"

  PROJECT="gproj"
  REPO="$SANDBOX/$PROJECT"
  mkdir -p "$REPO"
  # Initialise a real git repo so `git rev-parse --show-toplevel` resolves.
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t
  # The hook lives at .git/hooks/pre-commit normally; we invoke the SOURCE hook
  # directly with cwd = repo so REPO_ROOT resolves to $REPO.

  INSTANCES_DIR="$FAKEHOME/.igris/projects/$PROJECT/session/instances"
  mkdir -p "$INSTANCES_DIR"

  # instances + brief_status schema (mirrors brain-mcp-server/src/db.ts).
  sqlite3 "$DB" "
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
      metadata TEXT DEFAULT '{}'
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
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# run_guard [extra env...] — invoke the source hook with cwd=$REPO and a fake
# HOME. Captures combined stdout+stderr + exit status via bats `run`.
run_guard() {
  run bash -c "cd '$REPO' && HOME='$FAKEHOME' $* bash '$HOOK_SRC' 2>&1"
}

# seed_instance <brief> <status> <hostname> [phase]
seed_instance() {
  local brief="$1" istatus="$2" host="$3" phase="${4:-BUILDING}"
  sqlite3 "$DB" "
    INSERT INTO instances (id, machine_hostname, project_slug, current_brief, current_phase, status, last_activity_at)
      VALUES ('$brief-$host', '$host', '$PROJECT', '$brief', '$phase', '$istatus', datetime('now'));
  "
}

# seed_brief <brief> <phase> [status-spelling]
# The status spelling is parameterised because the live brain holds MORE THAN
# ONE in-flight spelling ('In Progress' 26 rows, 'InProgress' 4 rows as of
# TD-340). The guard must gate on the STATE, not on one notation of it.
seed_brief() {
  local brief="$1" phase="$2" bstatus="${3:-In Progress}"
  sqlite3 "$DB" "
    INSERT INTO brief_status (project, brief_id, title, status, phase)
      VALUES ('$PROJECT', '$brief', 't', '$bstatus', '$phase');
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
# (e) Fallback tier: no instances ROW in DB (so tier-1 yields empty), but a
#     per-instance session file carries **Active Brief:** FR-999. The guard
#     resolves the brief via the file tier; the phase lookup then finds the
#     seeded BUILDING brief_status row -> guard FIRES. This proves the
#     per-instance-file fallback wiring resolves the brief.
# -----------------------------------------------------------------------------
@test "(e) fallback to per-instance session file resolves the brief" {
  # No instances row -> tier 1 empty. brief_status row present for the lookup.
  seed_brief "FR-999" "BUILDING"
  cat > "$INSTANCES_DIR/aaaaaaaa-1111-2222-3333-444444444444.md" <<'MD'
## Status
**Mode:** HUNT MODE
**Instance ID:** aaaaaaaa-1111-2222-3333-444444444444
**Machine:** test (darwin)
**Updated:** 2026-06-17
**Active Brief:** FR-999 (some annotation)
MD

  run_guard
  [ "$status" -eq 1 ]
  [[ "$output" == *"FR-999"* ]]
  [[ "$output" == *"BUILDING"* ]]
}

# -----------------------------------------------------------------------------
# (e2) Fallback tier resolves a brief with NO claim ("Active Brief: None") ->
#      resolves to empty -> guard skips (a planning session must not gate).
# -----------------------------------------------------------------------------
@test "(e2) per-instance file with 'Active Brief: None' -> guard skips (exit 0)" {
  cat > "$INSTANCES_DIR/bbbbbbbb-1111-2222-3333-444444444444.md" <<'MD'
## Status
**Active Brief:** None — planning only
MD

  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing commit"* ]]
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
# -----------------------------------------------------------------------------

# add_machine_id_column — the instances v5 shape.
add_machine_id_column() {
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

# seed_instance_id <brief> <status> <hostname> <machine_id-or-NULL> [phase]
seed_instance_id() {
  local brief="$1" istatus="$2" host="$3" mid="$4" phase="${5:-BUILDING}"
  local mid_sql="NULL"
  [ "$mid" != "NULL" ] && mid_sql="'$mid'"
  sqlite3 "$DB" "
    INSERT INTO instances (id, machine_hostname, project_slug, current_brief, current_phase, status, last_activity_at, machine_id)
      VALUES ('$brief-$host', '$host', '$PROJECT', '$brief', '$phase', '$istatus', datetime('now'), $mid_sql);
  "
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
