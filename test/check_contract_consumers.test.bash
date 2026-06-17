#!/usr/bin/env bats

# check_contract_consumers.test.bash — FR-186. Tests for the mechanical
# contract→consumer impact-checker (scripts/check_contract_consumers.sh).
#
# The checker parses a MAINTAINING.md map, scans `git diff --cached` for
# deletions/renames of mapped tokens, and surfaces the consumer list. Default
# verdict is WARN (exit 0); the ONE hard-fail is a STALE MAP (a consumer
# citation whose file no longer exists -> exit 1).
#
# Test isolation
# --------------
# Each test builds a throwaway git repo under a scratch dir, writes a fixture
# MAINTAINING.md, stages files/diffs, and runs the REAL checker from inside the
# repo (so `git rev-parse --show-toplevel` resolves to the sandbox). The checker
# reads $REPO_ROOT/MAINTAINING.md by default; tests stage that file directly.
#
# Past mistakes to avoid (forger memory)
# --------------------------------------
# Memory ID 29: cover the edge verdicts (stale-map hard-fail, anchored-match
# no-false-positive, clean-diff no-op), not just the happy path.

load test_helper

CHECKER="$IGRIS_ROOT/scripts/check_contract_consumers.sh"

setup() {
  [ -f "$CHECKER" ] || { echo "checker not found at $CHECKER"; return 1; }
  command -v git >/dev/null 2>&1 || skip "git not available"

  SANDBOX="$(mktemp -d "${BATS_TMPDIR:-/tmp}/ccc.XXXXXX")"
  REPO="$SANDBOX/repo"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t
}

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}

# run_checker [args...] — run the checker from inside the sandbox repo.
run_checker() {
  run bash -c "cd '$REPO' && bash '$CHECKER' $* 2>&1"
}

# write_map <body-after-The-Map-heading...> via heredoc helper. Writes a
# MAINTAINING.md with a valid "## The Map" table.
write_map_file() {
  cat > "$REPO/MAINTAINING.md"
}

# -----------------------------------------------------------------------------
# (g) Mapped path deleted -> consumer list surfaced (default WARN -> exit 0,
#     but the consumer is named in the output).
# -----------------------------------------------------------------------------
@test "(g) mapped path deleted -> consumer surfaced (WARN, exit 0)" {
  mkdir -p "$REPO/foo"
  echo "old content" > "$REPO/foo/bar.md"
  mkdir -p "$REPO/scripts"
  echo "reads bar" > "$REPO/scripts/baz.sh"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `foo/bar.md` | `file` | `scripts/baz.sh:1` | FR-000 | re-point baz.sh |
MD
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm init

  # Stage a deletion of the mapped path.
  git -C "$REPO" rm -q foo/bar.md

  run_checker
  [ "$status" -eq 0 ]
  [[ "$output" == *"foo/bar.md"* ]]
  [[ "$output" == *"scripts/baz.sh:1"* ]]
}

# -----------------------------------------------------------------------------
# (h) Stale-map hard-fail: a staged MAINTAINING.md whose consumer cell cites a
#     file that does not exist -> exit 1, the bad path named.
# -----------------------------------------------------------------------------
@test "(h) staged map with nonexistent consumer file -> hard-fail (exit 1)" {
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `foo/bar.md` | `file` | `does/not/exist.sh:1` | FR-000 | re-point it |
MD
  git -C "$REPO" add MAINTAINING.md

  run_checker
  [ "$status" -eq 1 ]
  [[ "$output" == *"STALE MAP"* ]]
  [[ "$output" == *"does/not/exist.sh:1"* ]]
}

# -----------------------------------------------------------------------------
# (i) No false positive on substring: map an env-var IGRIS_BYPASS_PHASE_GUARD;
#     stage a diff removing a line containing IGRIS_BYPASS_PHASE_GUARD_EXTRA ->
#     anchored word-boundary match -> NO hit.
# -----------------------------------------------------------------------------
@test "(i) anchored match: _EXTRA suffix does not trigger the bare token" {
  echo "old: IGRIS_BYPASS_PHASE_GUARD_EXTRA=1" > "$REPO/code.sh"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `IGRIS_BYPASS_PHASE_GUARD` | `env-var` | `code.sh:1` | FR-000 | sweep it |
MD
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm init

  # Remove the line containing the _EXTRA superstring (not the bare token).
  echo "new content with nothing" > "$REPO/code.sh"
  git -C "$REPO" add code.sh

  run_checker
  [ "$status" -eq 0 ]
  [[ "$output" != *"IGRIS_BYPASS_PHASE_GUARD ("* ]]
  [[ "$output" != *"may break"* ]]
}

# -----------------------------------------------------------------------------
# (i2) Anchored match POSITIVE control: removing a line with the EXACT bare
#      token DOES trigger the hit (proves (i)'s no-hit was the boundary, not a
#      dead matcher).
# -----------------------------------------------------------------------------
@test "(i2) anchored match: exact bare token DOES trigger (consumer surfaced)" {
  echo "old: IGRIS_BYPASS_PHASE_GUARD=1 here" > "$REPO/code.sh"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `IGRIS_BYPASS_PHASE_GUARD` | `env-var` | `code.sh:1` | FR-000 | sweep it |
MD
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm init

  echo "removed the var" > "$REPO/code.sh"
  git -C "$REPO" add code.sh

  run_checker
  [ "$status" -eq 0 ]
  [[ "$output" == *"IGRIS_BYPASS_PHASE_GUARD"* ]]
  [[ "$output" == *"code.sh:1"* ]]
}

# -----------------------------------------------------------------------------
# (j) Clean diff -> no-op: stage an unrelated file (no mapped token touched) ->
#     checker exits 0 silently (no consumer warnings).
# -----------------------------------------------------------------------------
@test "(j) unrelated clean diff -> no-op (exit 0, no warnings)" {
  echo "hello" > "$REPO/unrelated.txt"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `foo/bar.md` | `file` | `scripts/baz.sh:1` | FR-000 | re-point baz.sh |
MD
  mkdir -p "$REPO/scripts"
  echo "x" > "$REPO/scripts/baz.sh"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm init

  echo "new unrelated line" >> "$REPO/unrelated.txt"
  git -C "$REPO" add unrelated.txt

  run_checker
  [ "$status" -eq 0 ]
  [[ "$output" != *"may break"* ]]
  [[ "$output" != *"STALE MAP"* ]]
}

# -----------------------------------------------------------------------------
# (k) Wiring smoke: --paths advisory mode surfaces consumers for a named path
#     even without a staged diff (the standalone preview the architect/
#     orchestrator can run).
# -----------------------------------------------------------------------------
@test "(k) --paths advisory mode previews consumers of a named path" {
  mkdir -p "$REPO/scripts"
  echo "x" > "$REPO/scripts/baz.sh"
  echo "y" > "$REPO/foo-bar.md"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `foo-bar.md` | `file` | `scripts/baz.sh:1` | FR-000 | re-point baz.sh |
MD
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm init

  run_checker "--paths foo-bar.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"scripts/baz.sh:1"* ]]
}

# -----------------------------------------------------------------------------
# (k2) Wiring smoke: no MAINTAINING.md present -> fail-open (exit 0, silent).
#      Proves the checker is a no-op in repos that have not adopted FR-186.
# -----------------------------------------------------------------------------
@test "(k2) no MAINTAINING.md -> fail-open no-op (exit 0)" {
  echo "x" > "$REPO/whatever.txt"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm init
  echo "y" >> "$REPO/whatever.txt"
  git -C "$REPO" add whatever.txt

  run_checker
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
