#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# check_contract_consumers.test.bash — FR-186. Tests for the mechanical
# contract→consumer impact-checker (scripts/check_contract_consumers.sh).
#
# The checker parses a MAINTAINING.md map, scans `git diff --cached` for
# deletions/renames of mapped tokens, and surfaces the consumer list. Default
# verdict is WARN (exit 0). A STALE MAP is the hard-fail (exit 1). Its causes
# are NOT listed here: the one list lives in the checker's header, printed by
# `scripts/check_contract_consumers.sh --help` (TD-346). A header that counted
# them went stale twice (TD-334 grew the set; TD-313, TD-466 and TD-346 grew
# it again). A citation pointing at a blank line or a bare
# closing delimiter WARNS at exit 0 — a proxy for "points at a construct"
# should not veto a commit.
#
# Every fixture map ends with a `<!-- MAP:END -->` line (TD-466) and backticks
# only distinctive Contract tokens (`thing_contract`, never a bare `thing`:
# TD-313 no longer registers a single alphabetic word). A fixture without the
# marker is a STALE MAP wherever the map is validated — (z4) is the one that
# omits it on purpose.
#
# CCC_CHECKER_UNDER_TEST — the checker under test defaults to the repo's
# scripts/check_contract_consumers.sh; point this variable at a scratch copy
# to run the whole suite against a mutant or an older build without touching
# the repo file (red-first: every TD-435/313/466/346 case was run against the
# 085badc checker this way before its phase was implemented).
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

CHECKER="${CCC_CHECKER_UNDER_TEST:-$IGRIS_ROOT/scripts/check_contract_consumers.sh}"

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
  git -C "${REPO:?}" init -q
  git -C "${REPO:?}" config user.email t@t.t
  git -C "${REPO:?}" config user.name t
}

teardown() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
  cleanup_test_temp_dir
}

# run_checker [args...] — run the checker from inside the sandbox repo.
run_checker() {
  run bash -c "cd '${REPO:?}' && bash '$CHECKER' $* 2>&1"
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

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init

  # Stage a deletion of the mapped path.
  git -C "${REPO:?}" rm -q foo/bar.md

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

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add MAINTAINING.md

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

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init

  # Remove the line containing the _EXTRA superstring (not the bare token).
  echo "new content with nothing" > "$REPO/code.sh"
  git -C "${REPO:?}" add code.sh

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

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init

  echo "removed the var" > "$REPO/code.sh"
  git -C "${REPO:?}" add code.sh

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

<!-- MAP:END -->
MD
  mkdir -p "$REPO/scripts"
  echo "x" > "$REPO/scripts/baz.sh"
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init

  echo "new unrelated line" >> "$REPO/unrelated.txt"
  git -C "${REPO:?}" add unrelated.txt

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

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init

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
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init
  echo "y" >> "$REPO/whatever.txt"
  git -C "${REPO:?}" add whatever.txt

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
| `thing_contract` | `protocol` | `src/lib/NOT_A_REAL_FILE.ts` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `pages/Graph.tsx` (short form) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1

  # Same short form, one letter off -> nothing in the tree ends with it.
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `pages/Graphs.tsx` (short form) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
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
| `thing_contract` | `protocol` | `src/lib/real.ts:99999` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `src/lib/real.ts:1` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `src/lib/real.ts:1-500` (a range) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "names line 500" || return 1

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts:1,500` (a list) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "names line 500" || return 1

  # Both numbers in range -> clean.
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts:1-3` (a range) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
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
| `thing_contract` | `protocol` | `src/lib/real.ts:2` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `src/lib/real.ts:3` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `src/lib/real.ts:2` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `skills/*/NOPE.md` (all skills) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "skills/*/NOPE.md" || return 1
  assert_contains "matches nothing" || return 1

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `skills/*/SKILL.md` (all skills) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
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
| `thing_contract` | `protocol` | `docs/{one,gone}.md` (two docs) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "docs/gone.md" || return 1

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `docs/{one,two}.md` (two docs) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
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
| `thing_contract` | `protocol` | `src/lib/**` (everything under it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1

  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/nosuchdir/**` (everything under it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
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
| `thing_contract` | `protocol` | `src/lib/real.ts` (`buildBrainGraph(db, opts)` builds it; the schema pointer is `$defs/surface_contract`, the tool family is `igris_catalog_*`, the harness doc is `core/os/harness-specific/<harness>.md`, the runtime reader is `~/.igris/core/skills/boot/SKILL.md`, the import specifier is `../../../db.js`, the placeholder line ref is `handlers.ts:NN`, the sibling repo doc is `fifty_dev:docs/brand/dataviz.md`, and `index.ts` is shorthand) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `dist/bundle/thing.js` (generated) | TD-334 | rebuild it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker
  [ "$status" -eq 0 ]
  assert_not_contains "STALE MAP" || return 1

  # ARM: the same path with no .gitignore rule covering it DOES fail, proving
  # the skip came from the ignore rule and not from the path shape.
  echo "unrelated/" > "$REPO/.gitignore"
  git -C "${REPO:?}" add -A
  run_checker
  [ "$status" -eq 1 ]
  assert_contains "dist/bundle/thing.js" || return 1
}

# =============================================================================
# TD-435 — a git-ignored citation is classified GENERATED before it is
# resolved, so the verdict and the validated count are the same in a built
# tree, a clean clone and a worktree.
#
# `git check-ignore pkg/dist` reports a bare directory as ignored by a `dist/`
# rule ONLY when the directory exists on disk (it cannot know an absent path is
# a directory). The checker therefore also probes `pkg/dist/`, and it asks git
# BEFORE trying to resolve the path, because a built tree would otherwise
# resolve the artifact and count it as validated.
# =============================================================================

# run_checker_in <dir> [args...] — like run_checker, from another checkout.
run_checker_in() {
  local dir="$1"
  shift
  run bash -c "cd '${dir:?}' && bash '$CHECKER' $* 2>&1"
}

# summary_line — the `map citations:` line of the last run.
summary_line() {
  printf '%s\n' "$output" | sed -n 's/^.*\(map citations: .*\)$/\1/p'
}

# -----------------------------------------------------------------------------
# (q2) A BARE git-ignored directory (no trailing slash) that is absent on disk
#      is generated, not a missing file. At 085badc: exit 1, STALE MAP.
# -----------------------------------------------------------------------------
@test "(q2) TD-435: a bare git-ignored dir absent on disk is generated, not stale" {
  seed_repo_with_map
  echo "dist/" > "$REPO/.gitignore"
  mkdir -p "$REPO/pkg/src"
  echo "a" > "$REPO/pkg/src/a.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `pkg/dist` (the build output dir) | TD-435 | rebuild it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  [ ! -e "$REPO/pkg/dist" ] || { echo "FIXTURE NOT ARMED: pkg/dist exists" >&2; return 1; }

  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  assert_not_contains "STALE MAP" || return 1
  assert_contains "1 generated" || return 1
  assert_contains "map citations: 0 validated" || return 1
}

# -----------------------------------------------------------------------------
# (q3) Clean-clone parity: the SAME commit, checked by the same checker in a
#      built tree (REPO, with an untracked ignored pkg/dist/bundle.js) and in a
#      fresh clone of it (no build output). Both exit 0 and print the SAME
#      `map citations:` line. The clone is of the SANDBOX repo, never the real
#      one, and no `git worktree add` is used (the TD-388 hazard).
#      At 085badc: REPO validates 3 and exits 0, the CLONE fails STALE.
# -----------------------------------------------------------------------------
@test "(q3) TD-435: a built tree and its clean clone print the same summary, both exit 0" {
  echo "dist/" > "$REPO/.gitignore"
  mkdir -p "$REPO/pkg/src"
  echo "a" > "$REPO/pkg/src/a.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `pkg/dist` (output dir), `pkg/dist/bundle.js` (the bundle), `pkg/src/a.ts` (its source) | TD-435 | rebuild it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init
  # The "build": an untracked, ignored artifact in REPO only.
  mkdir -p "$REPO/pkg/dist"
  echo "built" > "$REPO/pkg/dist/bundle.js"
  local CLONE="$SANDBOX/clone"
  git clone -q "${REPO:?}" "${CLONE:?}"
  [ ! -e "$CLONE/pkg/dist" ] || { echo "FIXTURE NOT ARMED: the clone has pkg/dist" >&2; return 1; }
  [ -e "$REPO/pkg/dist/bundle.js" ] || { echo "FIXTURE NOT ARMED: REPO is not built" >&2; return 1; }

  run_checker_in "$REPO" "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  local built
  built="$(summary_line)"

  run_checker_in "$CLONE" "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  local clean
  clean="$(summary_line)"

  [ -n "$built" ] || { echo "no summary line from the built tree" >&2; return 1; }
  if [ "$built" != "$clean" ]; then
    echo "summary differs between checkouts:" >&2
    echo "  built: $built" >&2
    echo "  clone: $clean" >&2
    return 1
  fi
  output="$built"
  assert_contains "map citations: 1 validated" || return 1
  assert_contains "2 generated" || return 1
}

# -----------------------------------------------------------------------------
# (q4) CONTROL for (q2)/(q3): a genuinely missing SOURCE citation still
#      hard-fails in the clean clone, and is named.
# -----------------------------------------------------------------------------
@test "(q4) TD-435: a missing source citation still fails in the clean clone" {
  echo "dist/" > "$REPO/.gitignore"
  mkdir -p "$REPO/pkg/src"
  echo "a" > "$REPO/pkg/src/a.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `pkg/dist` (output dir), `pkg/src/missing.ts` (a source that is gone) | TD-435 | rebuild it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init
  local CLONE="$SANDBOX/clone"
  git clone -q "${REPO:?}" "${CLONE:?}"

  run_checker_in "$CLONE" "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "STALE MAP" || return 1
  assert_contains "pkg/src/missing.ts" || return 1
  assert_not_contains "'pkg/dist'" || return 1
}

# =============================================================================
# TD-313 — the row parser honours the GFM `\|` escape, a malformed row is a
# hard-fail at authoring time, and a bare single-word Contract token is not
# minted as a contract.
# =============================================================================

# -----------------------------------------------------------------------------
# (y1) An escaped `\|` in the Contract cell no longer shifts the columns: the
#      bogus citation in the Consumers cell is read and fails. At 085badc the
#      shift moved the Consumers cell out of column 3 and the run exited 0.
# -----------------------------------------------------------------------------
@test "(y1) TD-313: an escaped pipe does not shift the Consumers column" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `mode_a` \| `mode_b` | `protocol` | `src/lib/TD313_NOT_A_FILE.ts` (reads it) | TD-313 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "STALE MAP" || return 1
  assert_contains "src/lib/TD313_NOT_A_FILE.ts" || return 1
}

# -----------------------------------------------------------------------------
# (y2) A BARE pipe inside a code span splits the row into the wrong number of
#      cells. That is a malformed row: exit 1, naming the map line and the cell
#      count. At 085badc: exit 0 (the extra cell was silently ignored).
# -----------------------------------------------------------------------------
@test "(y2) TD-313: a bare pipe in a cell is a malformed row (exit 1, line + cell count)" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-313 | re-run `grep -E 'a|b'` |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "STALE MAP: malformed map row" || return 1
  assert_contains "MAINTAINING.md:7" || return 1
  assert_contains "8 cells" || return 1

  # ARM: the same row with the pipe escaped is clean.
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-313 | re-run `grep -E 'a\|b'` |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  assert_not_contains "STALE MAP" || return 1
}

# -----------------------------------------------------------------------------
# (y3) A bare generic word in the Contract cell is not registered: removing a
#      line that holds both `nodes` and `NODE_TABLE` warns for NODE_TABLE only.
#      At 085badc both warned.
# -----------------------------------------------------------------------------
@test "(y3) TD-313: a bare single-word Contract token does not fire the sweep" {
  echo "const NODE_TABLE = nodes;" > "$REPO/code.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `nodes` / `NODE_TABLE` | `column` | `code.ts:1` | TD-313 | sweep it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init
  echo "const other = 1;" > "$REPO/code.ts"
  git -C "${REPO:?}" add code.ts

  run_checker
  [ "$status" -eq 0 ] || return 1
  assert_contains "'NODE_TABLE' (column) is a mapped contract changed in this diff." || return 1
  assert_not_contains "'nodes' (" || return 1
}

# -----------------------------------------------------------------------------
# (y4) A row whose ONLY Contract tokens are bare words registers nothing, so it
#      could never fire. That is a hard-fail under verdict 2.
# -----------------------------------------------------------------------------
@test "(y4) TD-313: a row that registers no contract token is a hard-fail" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `nodes` / `edges` | `column` | `src/lib/real.ts` (reads it) | TD-313 | sweep it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "registers no contract token" || return 1
  assert_contains "MAINTAINING.md:7" || return 1
}

# -----------------------------------------------------------------------------
# (y5) --list-tokens prints exactly the registered tokens, one per line, as
#      <map line>\t<type>\t<token>, and exits 0. It is a usage error beside
#      --paths.
# -----------------------------------------------------------------------------
@test "(y5) TD-313: --list-tokens prints exactly the distinctive tokens" {
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `nodes` / `NODE_TABLE` | `column` | `code.ts:1` | TD-313 | sweep it |
| `IGRIS_TD313_FLAG` \| `Done` | `env-var` | `code.ts:1` | TD-313 | sweep it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run bash -c "cd '${REPO:?}' && bash '$CHECKER' --list-tokens 2>/dev/null"
  [ "$status" -eq 0 ] || return 1
  local expected
  expected="$(printf '7\tcolumn\tNODE_TABLE\n8\tenv-var\tIGRIS_TD313_FLAG')"
  if [ "$output" != "$expected" ]; then
    echo "expected:" >&2; printf '%s\n' "$expected" >&2
    echo "actual:" >&2; printf '%s\n' "$output" >&2
    return 1
  fi

  run_checker "--list-tokens --paths MAINTAINING.md"
  [ "$status" -eq 2 ] || return 1
  assert_contains "--list-tokens" || return 1
}

# -----------------------------------------------------------------------------
# (y6) The REAL map: --list-tokens exits 0, lists tokens, and none of them is a
#      bare single word (lowercase, Capitalised or ALLCAPS).
# -----------------------------------------------------------------------------
@test "(y6) TD-313: the real map registers no bare single-word token" {
  [ -f "$IGRIS_ROOT/MAINTAINING.md" ] || skip "no MAINTAINING.md in this repo"
  run bash -c "cd '${IGRIS_ROOT:?}' && bash '$CHECKER' --list-tokens 2>&1"
  [ "$status" -eq 0 ] || return 1
  local n bare
  n="$(printf '%s\n' "$output" | awk -F'\t' 'NF == 3' | wc -l | tr -d ' ')"
  [ "$n" -gt 100 ] || { echo "only $n tokens listed: $output" >&2; return 1; }
  bare="$(printf '%s\n' "$output" | awk -F'\t' 'NF == 3 && $3 ~ /^([a-z]+|[A-Z][a-z]*|[A-Z]+)$/')"
  [ -z "$bare" ] || { echo "bare single-word tokens registered:" >&2; echo "$bare" >&2; return 1; }
}

# =============================================================================
# TD-466 — the map window runs from `## The Map` to an explicit
# `<!-- MAP:END -->` terminator. A heading inside the window no longer ends it
# (six real rows sat below `## Citation conventions` and were never parsed); a
# missing terminator, or a map row placed after it, is itself a STALE MAP.
# =============================================================================

# -----------------------------------------------------------------------------
# (z1) A row AFTER an H2 inside the window is parsed: its drifted citation
#      fails. At 085badc the H2 ended the window and the run exited 0.
# -----------------------------------------------------------------------------
@test "(z1) TD-466: a row after an H2 inside the window is still validated" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-466 | re-point it |

## A heading inside the map region

| `later_contract` | `protocol` | `src/lib/TD466_DRIFTED.ts` (reads it) | TD-466 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "STALE MAP" || return 1
  assert_contains "src/lib/TD466_DRIFTED.ts" || return 1
}

# -----------------------------------------------------------------------------
# (z2) CONTROL: the same drift in a row BEFORE the H2 fails too (the new window
#      did not narrow what was already covered).
# -----------------------------------------------------------------------------
@test "(z2) TD-466 control: a drift before the H2 still fails" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/TD466_DRIFTED.ts` (reads it) | TD-466 | re-point it |

## A heading inside the map region

| `later_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-466 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "src/lib/TD466_DRIFTED.ts" || return 1
}

# -----------------------------------------------------------------------------
# (z3) An illustration table AFTER the terminator (the real map's Citation
#      conventions table has two columns) is excluded: its bogus path is not
#      validated, the validated count equals the same map without the table,
#      and --list-tokens lists nothing at or after the marker line (9).
# -----------------------------------------------------------------------------
@test "(z3) TD-466: an illustration table after MAP:END is excluded" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-466 | re-point it |

<!-- MAP:END -->

## Citation conventions

| You write | The checker does |
|---|---|
| `src/lib/TD466_ILLUSTRATION_ONLY.ts` | resolves it |
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  assert_not_contains "TD466_ILLUSTRATION_ONLY" || return 1
  local with_table
  with_table="$(summary_line)"

  run bash -c "cd '${REPO:?}' && bash '$CHECKER' --list-tokens 2>&1"
  [ "$status" -eq 0 ] || return 1
  local late
  late="$(printf '%s\n' "$output" | awk -F'\t' 'NF == 3 && $1 >= 9')"
  [ -z "$late" ] || { echo "tokens listed from at/after MAP:END: $late" >&2; return 1; }

  # The same map without the table prints the same summary.
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-466 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  [ "$(summary_line)" = "$with_table" ] || {
    echo "summary moved: with table [$with_table] without [$(summary_line)]" >&2; return 1; }
}

# -----------------------------------------------------------------------------
# (z4) `## The Map` with NO terminator. Wherever verdict 2 runs it is a STALE
#      MAP (never a silent fall-back to the old window); with the map unstaged
#      in staged mode, a loud WARN says the token sweep did NOT run (exit 0).
# -----------------------------------------------------------------------------
@test "(z4) TD-466: a missing MAP:END is a STALE MAP (--paths) and a loud WARN (unstaged)" {
  seed_repo_with_map
  echo "const TD466_TOKEN = 1;" > "$REPO/code.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `TD466_TOKEN` | `column` | `src/lib/real.ts` (reads it) | TD-466 | re-point it |
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init

  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "no <!-- MAP:END --> terminator" || return 1

  # Staged mode, map committed and unstaged, a diff that removes the token.
  echo "const other = 2;" > "$REPO/code.ts"
  git -C "${REPO:?}" add code.ts
  run_checker
  [ "$status" -eq 0 ] || return 1
  assert_contains "WARN" || return 1
  assert_contains "the token sweep did NOT run" || return 1
  assert_not_contains "'TD466_TOKEN' (column) is a mapped contract" || return 1
}

# -----------------------------------------------------------------------------
# (z5) A 5-column map row placed AFTER the terminator is never parsed, so it is
#      a STALE MAP by itself (the six-stray-rows recurrence). A two-column
#      illustration table after the marker is not flagged.
# -----------------------------------------------------------------------------
@test "(z5) TD-466: a map row after MAP:END is a STALE MAP; an illustration table is not" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-466 | re-point it |

<!-- MAP:END -->

| You write | The checker does |
|---|---|
| `src/lib/real.ts` | resolves it |

| `stray_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-466 | re-point it |
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "map row after <!-- MAP:END --> at MAINTAINING.md:15" || return 1
  local n
  n="$(printf '%s\n' "$output" | grep -c 'map row after <!-- MAP:END -->' || true)"
  [ "$n" -eq 1 ] || { echo "expected ONE after-marker finding, got $n: $output" >&2; return 1; }
}

# -----------------------------------------------------------------------------
# (z6) ARM on the REAL map: a citation unique to BR-106's row — one of the six
#      rows that sat after `## Citation conventions` — drifted in a COPY now
#      fails. At 085badc the identical edit was a no-op (exit 0), which is the
#      sentinel finding TD-466 was filed from.
# -----------------------------------------------------------------------------
@test "(z6) TD-466 ARM: a drift in the formerly ungated BR-106 row fails on the real map" {
  [ -f "$IGRIS_ROOT/MAINTAINING.md" ] || skip "no MAINTAINING.md in this repo"
  local armed="$SANDBOX/armed-z6.md"
  sed 's|auto-push-fence\.ts:169|auto-push-fence.ts:99999|' "$IGRIS_ROOT/MAINTAINING.md" > "$armed"
  if cmp -s "$armed" "$IGRIS_ROOT/MAINTAINING.md"; then
    echo "ARM NOT PLANTED: MAINTAINING.md no longer cites auto-push-fence.ts:169" >&2
    return 1
  fi
  run bash -c "cd '${IGRIS_ROOT:?}' && bash '$CHECKER' --map '$armed' --paths MAINTAINING.md 2>&1"
  [ "$status" -eq 1 ] || return 1
  assert_contains "auto-push-fence.ts:99999" || return 1
  assert_contains "names line 99999" || return 1

  # Second arm, the incident's own shape on the real map: a heading placed
  # above BR-106's row inside the window does not hide the same drift. (The
  # real map has no heading inside its window today, so without this arm a
  # checker that let any H2 end the window would pass z6.)
  local armed2="$SANDBOX/armed-z6-heading.md"
  awk 'index($0, "| The **`IGRIS_REAL_HOME` cross-tier escape hatch** (BR-106)") == 1 {
         print "## A heading inside the map region"; print "" }
       { print }' "$armed" > "$armed2"
  grep -x '## A heading inside the map region' "$armed2" >/dev/null || {
    echo "ARM NOT PLANTED: BR-106's row was not found to put a heading above" >&2; return 1; }
  run bash -c "cd '${IGRIS_ROOT:?}' && bash '$CHECKER' --map '$armed2' --paths MAINTAINING.md 2>&1"
  [ "$status" -eq 1 ] || return 1
  assert_contains "auto-push-fence.ts:99999" || return 1
  assert_not_contains "map row after" || return 1
}

# =============================================================================
# TD-346 — a short-form citation that more than one tracked path ends with is a
# coin flip, not a resolution: it hard-fails naming every candidate. And the
# run says what a clean result does NOT prove, where the number is printed.
# =============================================================================

# -----------------------------------------------------------------------------
# (l4) Two tracked files sharing a tail: planted -> red, removed -> green. At
#      085badc the planted state exited 0 (`grep -m1` took the first match).
# -----------------------------------------------------------------------------
@test "(l4) TD-346: a short form two tracked files end with is ambiguous; unique again after removal" {
  mkdir -p "$REPO/cli/pages"
  echo "g" > "$REPO/cli/pages/Graph.tsx"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `pages/Graph.tsx` (short form, relative to cli/) | TD-346 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init
  [ ! -e "$REPO/pages" ] || { echo "FIXTURE NOT ARMED: a root pages/ exists" >&2; return 1; }
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  assert_contains "map citations: 1 validated" || return 1

  # Plant the tail twin.
  mkdir -p "$REPO/vendor/legacy/pages"
  echo "v" > "$REPO/vendor/legacy/pages/Graph.tsx"
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm plant
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "STALE MAP: consumer citation 'pages/Graph.tsx' is ambiguous" || return 1
  assert_contains "cli/pages/Graph.tsx" || return 1
  assert_contains "vendor/legacy/pages/Graph.tsx" || return 1

  # Remove it: unique again.
  git -C "${REPO:?}" rm -q vendor/legacy/pages/Graph.tsx
  git -C "${REPO:?}" commit -qm unplant
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  assert_not_contains "ambiguous" || return 1
}

# -----------------------------------------------------------------------------
# (l5) The directory variant: `src/` with no root src/ and two tracked
#      directories ending with it. At 085badc: exit 0.
# -----------------------------------------------------------------------------
@test "(l5) TD-346: a short directory form two tracked dirs end with is ambiguous" {
  mkdir -p "$REPO/a/src" "$REPO/b/src"
  echo "x" > "$REPO/a/src/x.ts"
  echo "y" > "$REPO/b/src/y.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/` (the sources) | TD-346 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 1 ] || return 1
  assert_contains "consumer citation 'src/' is ambiguous" || return 1
  assert_contains "a/src/" || return 1
  assert_contains "b/src/" || return 1
}

# -----------------------------------------------------------------------------
# (l6) CONTROL for (l5): the full path resolves root-first and is clean — the
#      ambiguity rule applies to the suffix fallback only.
# -----------------------------------------------------------------------------
@test "(l6) TD-346 control: the full path a/src/ resolves root-first (exit 0)" {
  mkdir -p "$REPO/a/src" "$REPO/b/src"
  echo "x" > "$REPO/a/src/x.ts"
  echo "y" > "$REPO/b/src/y.ts"
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `a/src/` (the sources) | TD-346 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  assert_not_contains "ambiguous" || return 1
  assert_contains "map citations: 1 validated" || return 1
}

# -----------------------------------------------------------------------------
# (s2) The run says what a clean result does and does NOT prove, on the line
#      after the summary, and counts the unchecked file#symbol citations inside
#      the skipped total; --help carries the same NOT-checked statements.
# -----------------------------------------------------------------------------
@test "(s2) TD-346: the coverage line and --help state what a clean run does not prove" {
  seed_repo_with_map
  write_map_file <<'MD'
# MAINTAINING

## The Map

| Contract | Type | Consumers (file:line) | Owner brief | Change procedure |
|---|---|---|---|---|
| `thing_contract` | `protocol` | `src/lib/real.ts:1` (reads it), `src/lib/real.ts#readThing` (the symbol) | TD-346 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  run_checker "--paths MAINTAINING.md"
  [ "$status" -eq 0 ] || return 1
  assert_contains "1 skipped (not a repo path, or external; 1 of them file#symbol, NOT checked)" || return 1
  assert_contains "[contract-check] coverage: " || return 1
  assert_contains "It does NOT prove that a cited line is the construct the row describes" || return 1

  run bash -c "bash '$CHECKER' --help"
  [ "$status" -eq 0 ] || return 1
  assert_contains "does NOT prove that a cited line is the construct" || return 1
  assert_contains "file#symbol citations are counted, NOT checked" || return 1
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

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
| `thing_contract` | `protocol` | `src/lib/NOT_A_REAL_FILE.ts` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init
  echo "z" > "$REPO/unrelated.txt"
  git -C "${REPO:?}" add unrelated.txt

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
| `thing_contract` | `protocol` | `src/lib/real.ts` (reads it) | TD-334 | re-point it |

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

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
    echo
    echo "<!-- MAP:END -->"
  } > "$REPO/MAINTAINING.md"

  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -qm init
  # Stage the deletion: every line of schema.ts becomes a removed line, so the
  # 12 tokens sit at the TOP of a ~1.2 MB buffer.
  git -C "${REPO:?}" rm -q src/schema.ts
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
  removed_lines="$(git -C "${REPO:?}" diff --cached -U0 | grep -c '^-')"
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

<!-- MAP:END -->
MD
  git -C "${REPO:?}" add -A

  # Guard: the trigger's producer must actually exceed the pipe buffer, or the
  # test passes for the wrong reason.
  local nameonly_bytes
  nameonly_bytes="$(git -C "${REPO:?}" diff --cached --name-only | wc -c | tr -d ' ')"
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
  if ! git -C "${REPO:?}" diff --cached --name-only | grep -qxF MAINTAINING.md; then
    echo "FIXTURE NOT ARMED: MAINTAINING.md is not staged" >&2
    return 1
  fi

  # The `[ "$status" -eq 0 ]` below is LOAD-BEARING, not boilerplate:
  # check_map_self_consistency prints the `map citations:` summary line just
  # BEFORE its final `return "$bad"`, so a gate that RAN AND HARD-FAILED
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
