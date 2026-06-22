#!/usr/bin/env bats

# Tests for scripts/validate_brief_state_reconciliation.sh (TD-257).
#
# The validator reads brief_status.status/phase from a brain DB and cross-checks
# git log for closing commits, flagging status<->phase<->git contradictions:
#   C1 Done-but-not-COMPLETE  (status=Done, phase != COMPLETE)
#   C2 Done-but-no-commit     (status=Done, no commit references the brief)
#   C3 committed-but-open      (closing commit exists, status IN (Ready,Draft))
#
# It is fail-open (exit 0 silent) when sqlite3/DB absent or no rows, and honors
# BRAIN_DB / REPO_DIR / PROJECT env overrides for test injection. Each test
# builds a throwaway brain DB + git repo so the live repo/DB is never touched.

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_brief_state_reconciliation.sh"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"

  SCRATCH="$TEST_TEMP_DIR/recon_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
  FIXTURE_DB="$SCRATCH/knowledge.db"
  FIXTURE_REPO="$SCRATCH/repo"
  FIXTURE_PROJECT="repo"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

# Create a minimal brief_status table in the fixture DB. Mirrors the canonical
# columns the validator SELECTs (brief_id, status, phase) under the real schema's
# project FK + NOT NULL shape.
init_fixture_db() {
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  sqlite3 "$FIXTURE_DB" <<'SQL'
CREATE TABLE brief_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
SQL
}

# seed_brief <brief_id> <status> <phase>
seed_brief() {
  local bid="$1" status="$2" phase="$3"
  sqlite3 "$FIXTURE_DB" \
    "INSERT INTO brief_status (project, brief_id, title, status, phase)
       VALUES ('$FIXTURE_PROJECT', '$bid', 'T $bid', '$status', '$phase');"
}

# Initialize a fixture git repo (no commits yet).
init_fixture_repo() {
  command -v git >/dev/null 2>&1 || skip "git not available"
  mkdir -p "$FIXTURE_REPO"
  git -C "$FIXTURE_REPO" init -q
  git -C "$FIXTURE_REPO" config user.email "t@t.dev"
  git -C "$FIXTURE_REPO" config user.name "Test"
}

# make_closing_commit <brief_id> — a commit whose message references the brief.
make_closing_commit() {
  local bid="$1"
  echo "$bid" >> "$FIXTURE_REPO/log.txt"
  git -C "$FIXTURE_REPO" add -A
  git -C "$FIXTURE_REPO" commit -q -m "feat(x): do the thing

closes #$bid"
}

# Run the validator against the fixtures.
run_validator() {
  run env BRAIN_DB="$FIXTURE_DB" REPO_DIR="$FIXTURE_REPO" PROJECT="$FIXTURE_PROJECT" \
    bash "$VALIDATOR"
}

@test "validator is executable and shellcheck-clean" {
  [ -x "$VALIDATOR" ]
  if command -v shellcheck &> /dev/null; then
    run shellcheck "$VALIDATOR"
    assert_success
  else
    skip "shellcheck not available"
  fi
}

@test "literal-pin: names all three contradiction classes + the canonical phase enum" {
  # A future edit that silently drops a class (or the shared phase constant)
  # fails this test.
  run grep -c "C1" "$VALIDATOR"; [ "$status" -eq 0 ]
  run grep -c "C2" "$VALIDATOR"; [ "$status" -eq 0 ]
  run grep -c "C3" "$VALIDATOR"; [ "$status" -eq 0 ]
  grep -q "Done-but-not-COMPLETE" "$VALIDATOR"
  grep -q "Done-but-no-commit" "$VALIDATOR"
  grep -q "committed-but-open" "$VALIDATOR"
  # The shared phase enum constant TD-238 will source.
  grep -q "CANONICAL_PHASES" "$VALIDATOR"
  grep -q "TERMINAL_PHASE" "$VALIDATOR"
}

@test "positive: clean DB (every Done row is COMPLETE + committed) passes" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-100" "Done" "COMPLETE"
  make_closing_commit "FR-100"
  # An in-flight brief satisfies the invariant vacuously (not flagged).
  seed_brief "FR-101" "In Progress" "BUILDING"
  # A Ready brief with no commit is simply unbuilt (not flagged).
  seed_brief "FR-102" "Ready" "INIT"

  run_validator
  assert_success
  assert_output_contains "reconciliation clean"
}

@test "negative C1: Done but phase=COMMITTING is flagged" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-200" "Done" "COMMITTING"
  make_closing_commit "FR-200"   # commit exists, so ONLY C1 should fire

  run_validator
  assert_failure
  assert_output_contains "C1"
  assert_output_contains "FR-200"
  # C2 must NOT fire — a commit exists for this brief.
  run bash -c "echo '$output' | grep 'C2.*FR-200' || true"
  [ -z "$output" ]
}

@test "negative C2: Done + COMPLETE but no closing commit is flagged" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-300" "Done" "COMPLETE"
  # No commit referencing FR-300.

  run_validator
  assert_failure
  assert_output_contains "C2"
  assert_output_contains "FR-300"
}

@test "negative C3: closing commit exists but status=Ready is flagged (#811 inverse)" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-400" "Ready" "INIT"
  make_closing_commit "FR-400"

  run_validator
  assert_failure
  assert_output_contains "C3"
  assert_output_contains "FR-400"
}

@test "Archived is treated as terminal (C1 fires when phase != COMPLETE)" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-500" "Archived" "SUPERSEDED"
  make_closing_commit "FR-500"

  run_validator
  assert_failure
  assert_output_contains "C1"
  assert_output_contains "FR-500"
}

@test "fail-open: nonexistent BRAIN_DB path exits 0 with no output" {
  # No DB created at all.
  init_fixture_repo
  run env BRAIN_DB="$SCRATCH/does-not-exist.db" REPO_DIR="$FIXTURE_REPO" \
    PROJECT="$FIXTURE_PROJECT" bash "$VALIDATOR"
  assert_success
  [ -z "$output" ]
}

@test "fail-open: empty DB (no rows for project) exits 0" {
  init_fixture_db
  init_fixture_repo
  # No briefs seeded.
  run_validator
  assert_success
  [ -z "$output" ]
}

@test "fail-open: sqlite3 simulated-absent exits 0 with no output" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-600" "Done" "COMMITTING"   # a contradiction that WOULD flag

  # Simulate sqlite3 absence WITHOUT breaking the rest of PATH: build a curated
  # bin dir that symlinks every command the validator + bash need EXCEPT
  # sqlite3, then point PATH at it alone so `command -v sqlite3` fails.
  local fakebin="$SCRATCH/curatedbin"
  mkdir -p "$fakebin"
  for cmd in bash sh git grep sed tr basename dirname realpath cat env head; do
    local p
    p="$(command -v "$cmd" 2>/dev/null || true)"
    [ -n "$p" ] && ln -sf "$p" "$fakebin/$cmd"
  done

  run env PATH="$fakebin" BRAIN_DB="$FIXTURE_DB" REPO_DIR="$FIXTURE_REPO" \
    PROJECT="$FIXTURE_PROJECT" "$fakebin/bash" "$VALIDATOR"
  assert_success
  [ -z "$output" ]
}

@test "env override: PROJECT scopes the query (other projects ignored)" {
  init_fixture_db
  init_fixture_repo
  # Seed a contradiction under a DIFFERENT project — must NOT be flagged when
  # PROJECT points at the fixture project.
  sqlite3 "$FIXTURE_DB" \
    "INSERT INTO brief_status (project, brief_id, title, status, phase)
       VALUES ('other-proj', 'FR-700', 'T', 'Done', 'COMMITTING');"
  # And a clean row under the queried project.
  seed_brief "FR-701" "Done" "COMPLETE"
  make_closing_commit "FR-701"

  run_validator
  assert_success
  assert_output_contains "reconciliation clean"
}

@test "pre-commit integration: contradiction surfaces a WARN but does NOT block" {
  # Simulate the pre-commit run block's WARN downgrade: the validator exits 1
  # internally, but the hook block (modeled here) must still exit 0.
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-800" "Done" "COMMITTING"
  make_closing_commit "FR-800"

  run env BRAIN_DB="$FIXTURE_DB" REPO_DIR="$FIXTURE_REPO" PROJECT="$FIXTURE_PROJECT" \
    bash -c '
      if ! bash "'"$VALIDATOR"'"; then
        echo "[pre-commit] Brief-state contradictions surfaced above (WARN only — not blocking)."
      fi
      exit 0
    '
  assert_success
  assert_output_contains "C1"
  assert_output_contains "WARN only"
}
