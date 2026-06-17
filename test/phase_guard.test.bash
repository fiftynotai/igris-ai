#!/usr/bin/env bats

# phase_guard.test.bash — FR-186 / G-01R. Tests for the re-pointed PI-004
# phase guard in scripts/git-hooks/pre-commit.
#
# What changed (G-01R): the guard used to read the Active Brief from the
# retired session/CURRENT_SESSION.md. FR-133 archived that file, so the grep
# returned empty and the guard went silently inert. The fix re-points
# brief discovery to the brain `instances` registry (machine-scoped, freshest
# heartbeat), with a per-instance session-file fallback, then a legacy
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
      last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
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
    INSERT INTO instances (id, machine_hostname, project_slug, current_brief, current_phase, status, last_heartbeat_at)
      VALUES ('$brief-$host', '$host', '$PROJECT', '$brief', '$phase', '$istatus', datetime('now'));
  "
}

# seed_brief <brief> <phase>
seed_brief() {
  local brief="$1" phase="$2"
  sqlite3 "$DB" "
    INSERT INTO brief_status (project, brief_id, title, status, phase)
      VALUES ('$PROJECT', '$brief', 't', 'In Progress', '$phase');
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
