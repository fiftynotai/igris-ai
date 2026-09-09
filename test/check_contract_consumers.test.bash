#!/usr/bin/env bats

# check_contract_consumers.test.bash — FR-186. Tests for the mechanical
# contract→consumer impact-checker (scripts/check_contract_consumers.sh).
#
# The checker parses a MAINTAINING.md map, scans `git diff --cached` for
# deletions/renames of mapped tokens, and surfaces the consumer list. Default
# verdict is WARN (exit 0). A STALE MAP is the hard-fail (exit 1), and since
# TD-334 it has THREE causes, not one:
#   1. a citation naming a file that does not exist;
#   2. a citation whose line number is out of range for its file;
#   3. a glob (or brace member) that matches nothing.
# A citation pointing at a blank line or a bare closing delimiter WARNS at
# exit 0 — a proxy for "points at a construct" should not veto a commit.
# Tests (m)/(m3) cover cause 2 and (o)/(o2) cover cause 3, so a header saying
# "the ONE hard-fail is a missing file" would contradict this file's own tests.
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
#
# TD-341: a bare `[[ ... ]]` that is not the final command of an @test body does
# NOT fire bash's ERR trap, so bats reports `ok` on a FALSE assertion. Every
# substring assertion in this file therefore goes through assert_contains /
# assert_not_contains (a function whose nonzero return IS trapped) AND is
# written with an explicit `|| return 1`. Do not reintroduce a bare `[[ ]]`.

load test_helper

CHECKER="$IGRIS_ROOT/scripts/check_contract_consumers.sh"

# assert_contains <needle> — LITERAL substring assertion on $output.
# (test_helper's assert_output_contains is a REGEX match; these needles carry
# `*`, `{`, `(` and `.` and must not be read as a pattern.)
assert_contains() {
  if [[ "$output" != *"$1"* ]]; then
    echo "Expected output to contain the literal: $1" >&2
    echo "Actual output: $output" >&2
    return 1
  fi
}

assert_not_contains() {
  if [[ "$output" == *"$1"* ]]; then
    echo "Expected output NOT to contain the literal: $1" >&2
    echo "Actual output: $output" >&2
    return 1
  fi
}

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
  assert_contains "foo/bar.md" || return 1
  assert_contains "scripts/baz.sh:1" || return 1
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
  assert_contains "STALE MAP" || return 1
  assert_contains "does/not/exist.sh:1" || return 1
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
  assert_not_contains "IGRIS_BYPASS_PHASE_GUARD (" || return 1
  assert_not_contains "may break" || return 1
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
  assert_contains "IGRIS_BYPASS_PHASE_GUARD" || return 1
  assert_contains "code.sh:1" || return 1
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
  assert_not_contains "may break" || return 1
  assert_not_contains "STALE MAP" || return 1
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
  assert_contains "scripts/baz.sh:1" || return 1
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

# =============================================================================
# TD-334 (merges TD-322) — the map self-consistency check validates BOTH
# citation forms, and its skips are counted rather than silent.
#
# Every test below plants the defect and asserts RED, or removes it and asserts
# GREEN. A guard shown only green proves nothing — that is why this brief
# exists.
# =============================================================================

# seed_repo_with_map — commit a small tree the fixtures cite into, so the
# tracked-file index (`git ls-files`) is non-empty in the sandbox.
seed_repo_with_map() {
  mkdir -p "$REPO/src/lib" "$REPO/pages" "$REPO/skills/boot" "$REPO/skills/hunt" "$REPO/docs"
  echo "x" > "$REPO/src/lib/real.ts"
  echo "y" > "$REPO/pages/Graph.tsx"
  echo "b" > "$REPO/skills/boot/SKILL.md"
  echo "h" > "$REPO/skills/hunt/SKILL.md"
  echo "d" > "$REPO/docs/one.md"
  echo "e" > "$REPO/docs/two.md"
}

# -----------------------------------------------------------------------------
# (l) §A — a BARE-path citation naming a nonexistent file hard-fails. Before
#     TD-334 this exited 0 with no output: only `path:line` was ever checked.
# -----------------------------------------------------------------------------
@test "(l) bare-path citation to a nonexistent file -> hard-fail (exit 1)" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/NOT_A_REAL_FILE.ts` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 1 ]
  assert_contains "STALE MAP" || return 1
  assert_contains "src/lib/NOT_A_REAL_FILE.ts" || return 1
}

# -----------------------------------------------------------------------------
# (l2) POSITIVE CONTROL for (l): the identical map with the REAL filename exits
#      0. Proves (l)'s red came from the missing file, not from the new code
#      rejecting bare paths wholesale.
# -----------------------------------------------------------------------------
@test "(l2) bare-path citation to an existing file -> clean (exit 0)" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
  assert_contains "map citations: 1 validated" || return 1
}

# -----------------------------------------------------------------------------
# (l3) Short-form citations (relative to a directory the row's prose
#      establishes) resolve as a path SUFFIX of a tracked file — and a stale
#      short form still fails. Both directions in one test.
# -----------------------------------------------------------------------------
@test "(l3) short-form citation resolves by suffix; a stale short form fails" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `pages/Graph.tsx` (short form) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1

  # Same short form, one letter off -> nothing in the tree ends with it.
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `pages/Graphs.tsx` (short form) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "pages/Graphs.tsx" || return 1
}

# -----------------------------------------------------------------------------
# (m) §B — a citation whose line number does not exist hard-fails, and the
#     citation is named. Before TD-334 `gateway.ts:99999` exited 0.
# -----------------------------------------------------------------------------
@test "(m) line number past end of file -> hard-fail naming the citation" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts:99999` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 1 ]
  assert_contains "STALE MAP" || return 1
  assert_contains "src/lib/real.ts:99999" || return 1
  assert_contains "names line 99999" || return 1
}

# -----------------------------------------------------------------------------
# (m2) POSITIVE CONTROL for (m): the same file at a line that DOES exist is
#      clean, and is counted as a line-ref citation.
# -----------------------------------------------------------------------------
@test "(m2) in-range line number -> clean (exit 0), counted as a line ref" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts:1` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
  assert_contains "(1 with line refs)" || return 1
}

# -----------------------------------------------------------------------------
# (m3) A range (`:a-b`) and a list (`:a,b`) are checked NUMBER BY NUMBER — an
#      in-range first number does not excuse an out-of-range second.
# -----------------------------------------------------------------------------
@test "(m3) range/list line refs: the second number is checked too" {
  seed_repo_with_map
  printf 'a\nb\nc\n' > "$REPO/src/lib/real.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts:1-500` (a range) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "names line 500" || return 1

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts:1,500` (a list) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "names line 500" || return 1

  # Both numbers in range -> clean.
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts:1-3` (a range) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
}

# -----------------------------------------------------------------------------
# (n) A citation pointing at a BLANK line is WARNED, not failed (the chosen
#     posture — "points at a construct" is a proxy, not a proof). The warning
#     is real output and is counted, which is what the old header only claimed.
# -----------------------------------------------------------------------------
@test "(n) citation on a blank line -> WARN, exit 0, counted" {
  seed_repo_with_map
  printf 'const a = 1;\n\nconst b = 2;\n' > "$REPO/src/lib/real.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts:2` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 0 ]
  assert_contains "WARN" || return 1
  assert_contains "BLANK line" || return 1
  assert_contains "1 line-drift warning(s)" || return 1
  assert_not_contains "STALE MAP" || return 1
}

# -----------------------------------------------------------------------------
# (n2) A citation pointing at a bare closing delimiter is WARNED the same way.
# -----------------------------------------------------------------------------
@test "(n2) citation on a bare closing delimiter -> WARN, exit 0" {
  seed_repo_with_map
  printf 'function f() {\n  return 1;\n}\n' > "$REPO/src/lib/real.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts:3` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 0 ]
  assert_contains "bare closing delimiter" || return 1
  assert_contains "1 line-drift warning(s)" || return 1
}

# -----------------------------------------------------------------------------
# (n3) ARM CHECK for (n)/(n2): the SAME file cited at a line carrying real code
#      produces NO warning. Proves the warning tracks the line's content, not
#      the mere presence of a line ref.
# -----------------------------------------------------------------------------
@test "(n3) citation on a substantive line -> no warning (arm check)" {
  seed_repo_with_map
  printf 'function f() {\n  return 1;\n}\n' > "$REPO/src/lib/real.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts:2` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "WARN" || return 1
  assert_contains "0 line-drift warning(s)" || return 1
}

# -----------------------------------------------------------------------------
# (o) Glob disposition: globs are RESOLVED, not skipped. A glob matching zero
#     files is exactly the staleness worth catching.
# -----------------------------------------------------------------------------
@test "(o) glob matching nothing -> hard-fail; a matching glob is clean" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `skills/*/NOPE.md` (all skills) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "skills/*/NOPE.md" || return 1
  assert_contains "matches nothing" || return 1

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `skills/*/SKILL.md` (all skills) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
}

# -----------------------------------------------------------------------------
# (o2) Brace expansion: a member that no longer exists fails even though the
#      other members do. A glob-only rule would pass this.
# -----------------------------------------------------------------------------
@test "(o2) brace citation with a missing member -> hard-fail naming the member" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `docs/{one,gone}.md` (two docs) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "docs/gone.md" || return 1

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `docs/{one,two}.md` (two docs) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
}

# -----------------------------------------------------------------------------
# (o3) A trailing `/**` is validated as its directory ("**" is not a bash-3.2
#      pattern, so it cannot be expanded literally).
# -----------------------------------------------------------------------------
@test "(o3) trailing /** is validated as the directory" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/**` (everything under it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/nosuchdir/**` (everything under it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "src/nosuchdir/" || return 1
}

# -----------------------------------------------------------------------------
# (p) NO FALSE POSITIVES. The Consumers column is prose containing backticked
#     identifiers that are NOT files. A naive "contains a slash" rule fails
#     this test — that is the hazard the brief called out.
# -----------------------------------------------------------------------------
@test "(p) non-file backticked tokens do not produce a STALE MAP" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts` (`buildBrainGraph(db, opts)` builds it; the schema pointer is `$defs/surface_contract`, the tool family is `igris_catalog_*`, the harness doc is `core/os/harness-specific/<harness>.md`, the runtime reader is `~/.igris/core/skills/boot/SKILL.md`, the import specifier is `../../../db.js`, the placeholder line ref is `handlers.ts:NN`, the sibling repo doc is `fifty_dev:docs/brand/dataviz.md`, and `index.ts` is shorthand) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
  # Exactly one token in that cell is a repo path; the rest are counted skips,
  # not silent drops.
  assert_contains "map citations: 1 validated" || return 1
  assert_contains "9 skipped" || return 1
}

# -----------------------------------------------------------------------------
# (q) A citation git IGNORES is skipped, not failed: build output does not
#     exist on a clean checkout, so failing on it would make the gate
#     machine-dependent.
# -----------------------------------------------------------------------------
@test "(q) git-ignored (generated) citation is skipped, not failed" {
  seed_repo_with_map
  echo "dist/" > "$REPO/.gitignore"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `dist/bundle/thing.js` (generated) | TD-334 | rebuild it |
MD
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1

  # ARM: the same path with no .gitignore rule covering it DOES fail, proving
  # the skip came from the ignore rule and not from the path shape.
  echo "unrelated/" > "$REPO/.gitignore"
  git -C "$REPO" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "dist/bundle/thing.js" || return 1
}

# -----------------------------------------------------------------------------
# (r) SCOPE, documented: check_map_self_consistency reads column 3 ONLY. A
#     bogus citation planted in the CONTRACT cell is not seen. Anyone arming
#     this guard must plant into a Consumers cell or they will "prove" it works
#     when it never ran.
# -----------------------------------------------------------------------------
@test "(r) a bogus citation in the Contract column is NOT checked (column 3 only)" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `src/lib/NOT_A_REAL_FILE.ts` | `file` | `src/lib/real.ts` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
}

# -----------------------------------------------------------------------------
# (s) The staged gate is real: with MAINTAINING.md UNSTAGED, default mode does
#     not run the map check at all — which is exactly why an exit 0 from an
#     interactive pre-commit run proves nothing. `--paths` mode always runs it.
# -----------------------------------------------------------------------------
@test "(s) default mode skips the map check when the map is unstaged; --paths does not" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/NOT_A_REAL_FILE.ts` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm init
  echo "z" > "$REPO/unrelated.txt"
  git -C "$REPO" add unrelated.txt

  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
  assert_not_contains "map citations:" || return 1

  run_checker "--paths unrelated.txt"
  [ "$status" -eq 1 ]
  assert_contains "STALE MAP" || return 1
}

# -----------------------------------------------------------------------------
# (t) `--paths` cannot be silently vacuous: a comma-joined argument and a
#     no-argument invocation are usage errors (exit 2).
# -----------------------------------------------------------------------------
@test "(t) --paths rejects a comma-joined argument and an empty argument list" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing` | `protocol` | `src/lib/real.ts` (reads it) | TD-334 | re-point it |
MD
  git -C "$REPO" add -A

  run_checker "--paths a.ts,b.ts"
  [ "$status" -eq 2 ]
  assert_contains "SPACE-separated" || return 1

  run_checker "--paths"
  [ "$status" -eq 2 ]
  assert_contains "at least one path" || return 1

  # ARM: the space-separated form of the same invocation is accepted.
  run_checker "--paths a.ts b.ts"
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# (u) The REAL MAINTAINING.md passes, and (u2) proves that pass is not vacuous.
# -----------------------------------------------------------------------------
@test "(u) the real MAINTAINING.md validates clean" {
  [ -f "$IGRIS_ROOT/MAINTAINING.md" ] || skip "no MAINTAINING.md in this repo"

  run bash -c "cd '$IGRIS_ROOT' && bash '$CHECKER' --paths MAINTAINING.md 2>&1"
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1
  assert_contains "0 line-drift warning(s)" || return 1
}

@test "(u2) ARM: the real map with one planted bogus citation fails" {
  [ -f "$IGRIS_ROOT/MAINTAINING.md" ] || skip "no MAINTAINING.md in this repo"

  local armed="$SANDBOX/armed.md"
  sed 's|core/skills/hunt/SKILL\.md|core/skills/TD334_NOT_A_SKILL/SKILL.md|g' \
    "$IGRIS_ROOT/MAINTAINING.md" > "$armed"
  # The arm is only meaningful if the substitution actually landed. If the map
  # stops citing that path, fail loudly rather than pass vacuously.
  if cmp -s "$armed" "$IGRIS_ROOT/MAINTAINING.md"; then
    echo "ARM NOT PLANTED: MAINTAINING.md no longer cites core/skills/hunt/SKILL.md" >&2
    return 1
  fi

  run bash -c "cd '$IGRIS_ROOT' && bash '$CHECKER' --map '$armed' --paths MAINTAINING.md 2>&1"
  [ "$status" -eq 1 ]
  assert_contains "STALE MAP" || return 1
  assert_contains "core/skills/TD334_NOT_A_SKILL/SKILL.md" || return 1
}

# =============================================================================
# TD-345 — a MATCH must never be reported as "no match".
#
# The defect: `printf '%s\n' "$BIG" | grep -q PAT` under `set -o pipefail`.
# grep -q exits at the FIRST match; if the producer still has buffered output
# it dies of SIGPIPE (141); pipefail promotes 141 to the pipeline status; the
# caller reads "no match" for something that matched.
#
# ### FIXTURE ORIENTATION — READ BEFORE "CORRECTING" THESE TESTS ###
# The tokens are deliberately on the FIRST lines of the fixture, with the
# padding BELOW them. That orientation is not incidental; it is the whole test.
#
#   * A token matching LATE in a large buffer is the SAFE case. grep has to
#     read to (nearly) EOF to reach it, by which time the producer has already
#     written everything and exited 0 — no SIGPIPE, no false negative.
#   * A token matching EARLY in a large buffer is the DEFECTIVE case. grep
#     exits after roughly one read while hundreds of KB are still unwritten.
#
# Measured on this machine (macOS, bash 3.2, 64 KB pipe buffer), token on
# line 1, 40 trials of `printf | grep -q` under pipefail:
#
#   buffer 7,800,011 B, token on line 1      -> 40/40 spurious misses
#   buffer 7,800,011 B, token on LAST line   ->  0/40 spurious misses
#   buffer     1,961 B, token on line 1      ->  0/40 spurious misses
#
# So a fixture built the other way round — a token late in a big buffer, or an
# early token in a small buffer — passes GREEN against the unfixed script and
# proves nothing. Do not move the tokens to the bottom and do not shrink the
# padding below ~1 MB.
# =============================================================================

# _td345_big_fixture — build a sandbox repo whose staged deletion yields a
# ~1 MB REMOVED_LINES buffer with 12 mapped `column` tokens on its first
# 12 lines. Leaves the deletion staged and MAINTAINING.md committed (unstaged),
# so only the WARN scan half runs.
_td345_big_fixture() {
  mkdir -p "$REPO/src"
  echo "const consumer = 1;" > "$REPO/src/consumer.ts"

  {
    for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
      echo "  TD345_TOK_$n: text,"
    done
    # ~1.2 MB of padding BELOW the tokens (see FIXTURE ORIENTATION above).
    awk 'BEGIN { for (i = 0; i < 30000; i++) print "  filler_column_padding_to_widen_the_buffer: text," }'
  } > "$REPO/src/schema.ts"

  {
    echo "# MAINTAINING"
    echo
    echo "## The Map"
    echo
    echo "| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |"
    echo "|---|---|---|---|---|"
    for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
      echo "| \`TD345_TOK_$n\` | \`column\` | \`src/consumer.ts:1\` | TD-345 | re-point it |"
    done
  } > "$REPO/MAINTAINING.md"

  git -C "$REPO" add -A
  git -C "$REPO" commit -qm init
  # Stage the deletion: every line of schema.ts becomes a removed line, so the
  # 12 tokens sit at the TOP of a ~1.2 MB buffer.
  git -C "$REPO" rm -q src/schema.ts
}

# -----------------------------------------------------------------------------
# (v) TD-345 positive control: 12 tokens matching EARLY in a ~1.2 MB removed-
#     lines buffer must ALL be reported. Asserts every member by name — a count
#     of report lines would let one token's disappearance hide behind another's.
# -----------------------------------------------------------------------------
@test "(v) TD-345: every early-matching token in a 1MB buffer is reported" {
  _td345_big_fixture

  # Guard: the fixture is only meaningful if the buffer is actually large.
  local removed_lines
  removed_lines="$(git -C "$REPO" diff --cached -U0 | grep -c '^-')"
  if [ "$removed_lines" -lt 30000 ]; then
    echo "FIXTURE NOT ARMED: only $removed_lines removed lines, need >=30000" >&2
    return 1
  fi

  run_checker
  [ "$status" -eq 0 ] || return 1

  local n
  for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
    assert_contains "'TD345_TOK_$n' (column) is a mapped contract changed in this diff." || return 1
  done
  assert_contains "12 mapped contract(s) touched" || return 1
}

# -----------------------------------------------------------------------------
# (w) TD-345 determinism: the same fixture 5x must report 12 every time.
#     Note the `= 12` assertion is the ARMED half — the unfixed script is
#     stably WRONG (0), so "all five runs agree" alone would pass RED. The 5x
#     is the anti-flake half. Both are required.
# -----------------------------------------------------------------------------
@test "(w) TD-345: the mapped-contract count is 12 on all of 5 runs" {
  _td345_big_fixture

  local i counts=""
  for i in 1 2 3 4 5; do
    run_checker
    [ "$status" -eq 0 ] || return 1
    counts="$counts $(printf '%s\n' "$output" \
      | sed -n 's/^.*\[contract-check\] \([0-9][0-9]*\) mapped contract(s) touched.*$/\1/p' \
      | tail -1)"
  done

  output="run counts:$counts"
  assert_contains "run counts: 12 12 12 12 12" || return 1
}

# -----------------------------------------------------------------------------
# (x) TD-345 / F2: map_is_staged() was the same defect inside the TD-334
#     HARD-FAIL gate's trigger. `git diff --cached --name-only | grep -qxF
#     MAINTAINING.md` — the name list is index-sorted so MAINTAINING.md lands
#     in the first few hundred bytes; on a large staged set grep short-circuits
#     immediately, git dies of SIGPIPE, map_is_staged returns FALSE, and the
#     hard-fail map check SILENTLY DOES NOT RUN. The tell is the absence of the
#     `map citations:` summary line, so that is what this asserts — 5/5 runs.
#
#     Measured RED on a 501-path / 27,394-byte staged name list: the old form
#     returned false 40/40; the fixed form returned true 40/40.
#
#     THE SHIPPED FIX IS `| grep -xF … >/dev/null` — a PIPE with `-q` REMOVED,
#     not a herestring. An earlier draft of this brief used `<<<` and it was
#     declined on cost: against the ORACLE baseline (the same script with
#     pipefail off and `-q` kept) the herestring measured +33.5% where the
#     shipped form measures +3.5% — one interleaved run, 5 repetitions each,
#     medians, both emitting 152 warnings. bash 3.2.57 writes a $TMPDIR file
#     per herestring. The invariant is "the reader must not short-circuit",
#     NOT "no pipe" — so do not read the pipe here as non-compliant and do not
#     "restore" the herestring. See the sibling comment at
#     scripts/check_contract_consumers.sh token_hit().
# -----------------------------------------------------------------------------
@test "(x) TD-345: the map hard-fail gate still triggers on a large staged set" {
  mkdir -p "$REPO/src"
  echo "const consumer = 1;" > "$REPO/src/consumer.ts"

  # ~700 tracked files under long nested paths, so `--name-only` output is
  # comfortably past the 64 KB pipe buffer (measured: ~90 KB; 500 files gave
  # only 64,031 B, which sits inside the nondeterministic band and would make
  # this test flaky rather than armed).
  local d="$REPO/a_very_long_directory_name_segment/another_long_segment_here/and_a_third_one"
  mkdir -p "$d"
  local i
  for i in $(seq -w 1 700); do
    echo "x" > "$d/padding_file_with_a_deliberately_long_name_$i.txt"
  done

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `TD345_GATE_TOKEN` | `column` | `src/consumer.ts:1` | TD-345 | re-point it |
MD
  git -C "$REPO" add -A

  # Guard: the trigger's producer must actually exceed the pipe buffer, or the
  # test passes for the wrong reason.
  local nameonly_bytes
  nameonly_bytes="$(git -C "$REPO" diff --cached --name-only | wc -c | tr -d ' ')"
  if [ "$nameonly_bytes" -lt 65536 ]; then
    echo "FIXTURE NOT ARMED: --name-only is only $nameonly_bytes bytes, need >=65536" >&2
    return 1
  fi
  # Guard: MAINTAINING.md must be in the staged set at all.
  # NOTE: this `| grep -qxF` is NOT a TD-345 site. Condition (a) fails — no file
  # under test/ sets `pipefail` (verified TD-345: `git grep -n pipefail -- test/`
  # finds only prose, and `test_helper.bash` carries no `set -` line at all), and
  # a bats body runs with pipefail OFF (probed). It also fails LOUDLY rather than
  # silently: a spurious "no match" returns 1 with the message below. Do not read
  # it as a counter-example to the block above.
  if ! git -C "$REPO" diff --cached --name-only | grep -qxF MAINTAINING.md; then
    echo "FIXTURE NOT ARMED: MAINTAINING.md is not staged" >&2
    return 1
  fi

  # The `[ "$status" -eq 0 ]` below is LOAD-BEARING, not boilerplate:
  # check_map_self_consistency prints the `map citations:` summary line at
  # :536 BEFORE `return "$bad"` at :537, so a gate that RAN AND HARD-FAILED
  # still emits the exact string this test greps for. The grep proves the gate
  # RAN; only the exit code proves it ran AND PASSED — which is the
  # operator-facing half of "arming this gate does not block a commit".
  # Armed both ways: with a citation planted to hard-fail the gate, this test
  # goes RED on the status line while `seen` still reads "ran ran ran ran ran".
  #
  # The `|| return 1` is this file's TD-341 convention, applied for
  # consistency — NOT because a bare `[ ]` would be vacuous here. Measured, in
  # a bats body: a non-final bare `[ ]` DOES fail the test (single bracket is
  # the `test` BUILTIN, a simple command, so bash's ERR trap fires), while a
  # non-final bare `[[ ]]` does NOT (compound conditionals are exempt). TD-341
  # and the header above are about `[[ ]]`; do not generalise them to `[ ]`.
  local seen=""
  for i in 1 2 3 4 5; do
    run_checker
    [ "$status" -eq 0 ] || return 1
    if [[ "$output" == *"map citations:"* ]]; then
      seen="$seen ran"
    else
      seen="$seen SKIPPED"
    fi
  done

  output="gate:$seen"
  assert_contains "gate: ran ran ran ran ran" || return 1
}
