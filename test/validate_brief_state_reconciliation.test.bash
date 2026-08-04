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

# ===========================================================================
# TD-333 — the widened terminal arm, and the negative controls that prove
# each half of the widening is load-bearing.
# ===========================================================================

# Write a copy of the validator with its terminal `case` arm NARROWED back to
# the pre-TD-333 vocabulary, for use as a negative control. Proves the mutation
# actually landed before returning — a control that silently failed to mutate
# would "pass" for the wrong reason.
narrowed_validator() {
  local out="$SCRATCH/validator_narrow.sh"
  sed 's/^    done|archived|completed|complete)$/    done|archived)/' \
    "$VALIDATOR" > "$out"
  # ARM CHECK: the file must actually differ, and in exactly this way.
  ! cmp -s "$VALIDATOR" "$out" || return 1
  grep -q '^    done|archived)$' "$out" || return 1
  ! grep -q 'completed|complete)' "$out" || return 1
  echo "$out"
}

# The same, for the NOTATION half: strip the three `tr`/expansion fold lines so
# the case matches the raw status.
unfolded_validator() {
  local out="$SCRATCH/validator_unfolded.sh"
  sed 's/^  status_folded="\$(printf .*$/  status_folded="$status"/' "$VALIDATOR" \
    | sed '/^  status_folded="\${status_folded\/\//d' > "$out"
  ! cmp -s "$VALIDATOR" "$out" || return 1
  grep -q '^  status_folded="\$status"$' "$out" || return 1
  ! grep -q 'tr .\[:upper:\]' "$out" || return 1
  echo "$out"
}

run_with() {
  local script="$1"
  run env BRAIN_DB="$FIXTURE_DB" REPO_DIR="$FIXTURE_REPO" PROJECT="$FIXTURE_PROJECT" \
    bash "$script"
}

@test "TD-333 T12: Completed + phase=COMMITTING fires C1 (the exemption is closed)" {
  init_fixture_db
  init_fixture_repo
  # This row was TERMINAL by meaning and INVISIBLE to this validator for its
  # entire lifetime: `Completed` fell to the default arm, commented "other
  # in-flight states". 26 live rows were exempt exactly this way.
  seed_brief "FR-900" "Completed" "COMMITTING"
  make_closing_commit "FR-900"   # commit exists, so ONLY C1 should fire

  run_validator
  assert_failure
  assert_output_contains "C1"
  assert_output_contains "FR-900"
  # The report echoes the STORED spelling, not the folded key.
  assert_output_contains "status='Completed'"
}

@test "TD-333 T12 NEGATIVE CONTROL: the pre-TD-333 arm does NOT fire on Completed" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-900" "Completed" "COMMITTING"
  make_closing_commit "FR-900"

  local narrow
  narrow="$(narrowed_validator)" || return 1
  run_with "$narrow"
  # Silence, and exit 0 — the defect this widening removes.
  assert_success
  assert_output_contains "reconciliation clean"
}

@test "TD-333 T12: Complete (adjectival, 1 live row) fires C1 too" {
  init_fixture_db
  init_fixture_repo
  seed_brief "TD-001" "Complete" "DONE"
  make_closing_commit "TD-001"

  run_validator
  assert_failure
  assert_output_contains "C1"
  assert_output_contains "TD-001"
}

@test "TD-333 T12: the NOTATION fold catches DONE / in-flight spellings" {
  init_fixture_db
  init_fixture_repo
  # A terminal status in a notation the literal list never named.
  seed_brief "FR-901" "DONE" "COMMITTING"
  make_closing_commit "FR-901"

  run_validator
  assert_failure
  assert_output_contains "C1"
  assert_output_contains "FR-901"
}

@test "TD-333 T12 NEGATIVE CONTROL: without the notation fold, DONE escapes" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-901" "DONE" "COMMITTING"
  make_closing_commit "FR-901"

  local unfolded
  unfolded="$(unfolded_validator)" || return 1
  run_with "$unfolded"
  assert_success
  assert_output_contains "reconciliation clean"
}

@test "TD-333: InProgress stays VACUOUS — in-flight is not a contradiction" {
  init_fixture_db
  init_fixture_repo
  # The notation fold must not sweep an in-flight spelling into the terminal
  # arm. `inprogress` is neither terminal nor C3-eligible.
  seed_brief "BR-002" "InProgress" "BUILDING"
  seed_brief "BR-003" "In Progress" "BUILDING"
  seed_brief "BR-004" "in_progress" "BUILDING"

  run_validator
  assert_success
  assert_output_contains "reconciliation clean"
}

@test "TD-333: the three MISSING STATES stay VACUOUS — this validator does not decide" {
  init_fixture_db
  init_fixture_repo
  # Whether Cancelled/Superseded/Deferred are terminal for C1/C2 is the
  # follow-up lifecycle brief's question. Assuming an answer here would be the
  # planner deciding a brief's state (TD-311).
  seed_brief "TD-010" "Cancelled" "BUILDING"
  seed_brief "TD-011" "Superseded" "INIT"
  seed_brief "TD-012" "Deferred" "INIT"
  make_closing_commit "TD-010"

  run_validator
  assert_success
  assert_output_contains "reconciliation clean"
}

@test "TD-333: the SENTENCE and welded-payload statuses stay VACUOUS and unflagged" {
  init_fixture_db
  init_fixture_repo
  seed_brief "FR-054" "Split (see FR-061, FR-062, FR-063)" "INIT"
  seed_brief "BR-128" "Done(Resolvedbydec8d1f)" "COMMITTING"

  run_validator
  assert_success
  assert_output_contains "reconciliation clean"
}

@test "TD-333 T13: C3 is IDENTICAL across the whole fold source+target corpus" {
  init_fixture_db
  init_fixture_repo

  # Every fold SOURCE and every fold TARGET, plus the C3 population. No fold
  # source or target touches Ready/Draft, so C3 must be exactly 2 — this is the
  # cheapest tripwire TD-333 has: if C3 moves, something folded that must not.
  seed_brief "FR-001" "Completed" "COMPLETE"
  seed_brief "FR-002" "Complete" "COMPLETE"
  seed_brief "FR-003" "InProgress" "BUILDING"
  seed_brief "FR-004" "Done" "COMPLETE"
  seed_brief "FR-005" "In Progress" "BUILDING"
  seed_brief "FR-006" "Archived" "COMPLETE"
  seed_brief "FR-007" "Ready" "INIT"
  seed_brief "FR-008" "Draft" "INIT"
  for b in FR-001 FR-002 FR-003 FR-004 FR-005 FR-006 FR-007 FR-008; do
    make_closing_commit "$b"
  done

  run_validator
  assert_failure
  local c3_after
  c3_after="$(printf '%s\n' "$output" | grep -c 'CONTRADICTION C3' || true)"
  [ "$c3_after" -eq 2 ] || { echo "C3 was $c3_after, expected 2"; return 1; }

  # Now apply the v25 fold to the SAME corpus (Completed/Complete -> Done,
  # InProgress -> In Progress) and re-measure. C3 must be byte-identical.
  sqlite3 "$FIXTURE_DB" \
    "UPDATE brief_status SET status='Done' WHERE LOWER(TRIM(status)) IN ('completed','complete');
     UPDATE brief_status SET status='In Progress' WHERE LOWER(TRIM(status))='inprogress';"
  run_validator
  assert_failure
  local c3_folded
  c3_folded="$(printf '%s\n' "$output" | grep -c 'CONTRADICTION C3' || true)"
  [ "$c3_folded" -eq "$c3_after" ] || {
    echo "C3 MOVED across the fold: $c3_after -> $c3_folded"; return 1;
  }
}

@test "TD-333: the retained synonyms are still in the source (do NOT clean them up)" {
  # After v25 `completed`/`complete` match zero rows locally. They stay as
  # defense in depth for igris import (a deliberate non-consumer of the ingress
  # fold) and for any writer outside the fold table. Deleting them silently
  # re-opens the exemption.
  grep -q 'done|archived|completed|complete)' "$VALIDATOR" || return 1
  grep -q 'RETAINED SYNONYMS' "$VALIDATOR" || return 1
  # ...and the C3 arm was NOT widened with a third state.
  grep -q '^    ready|draft)$' "$VALIDATOR" || return 1
}
