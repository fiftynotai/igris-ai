#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2

# fixture_bats_guard.test.bash — TD-348. Two properties of the whole bats
# fixture set (test/*.test.bash and cli/tests/integration/*.bats):
#
#   1. Every fixture refuses to run under plain `bash` (test/require_bats.bash,
#      sourced by one canonical first line per directory). G1-G4, G6, G7.
#   2. No `git -C` argument in the fixture set can expand to an empty string,
#      which git reads as "the current directory" (the 270db43 incident). G5.
#
# CHILD-RUN DISCIPLINE (read before adding a case). This file loads
# test_helper, and test/test_helper.bash EXPORTS BATS_TEST_DIRNAME, so every
# child process inherits it. In a child running a CLI fixture under plain bash
# that inherited value replaces the canonical line's BASH_SOURCE fallback, the
# guard path resolves to a file that does not exist, and the child exits 2
# through `|| exit 2` WITHOUT the guard ever running. A status-only assertion
# would pass that run for the wrong reason. So:
#   - every child is spawned through run_plain_bash (BATS_VERSION and
#     BATS_TEST_DIRNAME unset: an operator's plain `bash`) or run_nested_bash
#     (only BATS_TEST_DIRNAME unset: BATS_VERSION is inherited from this bats
#     run, i.e. the nested case the `load` arm exists for);
#   - both helpers first prove the unset takes effect on this host's `env`;
#   - every refusal is asserted three ways: exit 2, the guard's own literal
#     `require_bats: refusing to run`, and NO `No such file`. G4n proves those
#     assertions tell a real refusal from a mis-resolved source path.
# An unguarded fixture ALSO exits 2 under plain bash (bash's syntax error at
# the first stray `}`), but only after running its first @test body at top
# level. Exit 2 alone is therefore never evidence of a refusal.
#
# SAFETY. No case executes a fixture whose guard line is absent (the static
# precondition runs first), and every child runs from a scratch dir under
# $BATS_TEST_TMPDIR with HOME fenced and GIT_CEILING_DIRECTORIES set.

load test_helper

# The two canonical guard lines, byte-for-byte. The single quotes are
# deliberate: these are the LITERAL texts a fixture must carry.
# shellcheck disable=SC2016
ROOT_GUARD_LINE='source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2'
# shellcheck disable=SC2016
CLI_GUARD_LINE='source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../../../test/require_bats.bash" || exit 2'
REFUSAL='require_bats: refusing to run'
INCIDENT_FIXTURE="$IGRIS_ROOT/test/check_contract_consumers.test.bash"
CLI_ANCHOR_FIXTURE="$IGRIS_ROOT/cli/tests/integration/home-fence.bats"

setup() {
  CHILD_HOME="$BATS_TEST_TMPDIR/home"
  SCRATCH="$BATS_TEST_TMPDIR/scratch"
  mkdir -p "$CHILD_HOME" "$SCRATCH"
  cd "$SCRATCH" || return 1
}

# assert_contains <haystack> <needle> — LITERAL substring. test_helper's
# assert_output_contains is a regex, and these needles carry `$`, `{`, `(`.
assert_contains() {
  if [[ "$1" != *"$2"* ]]; then
    echo "expected to contain the literal: $2" >&2
    echo "actual: $1" >&2
    return 1
  fi
}

assert_not_contains() {
  if [[ "$1" == *"$2"* ]]; then
    echo "expected NOT to contain the literal: $2" >&2
    echo "actual: $1" >&2
    return 1
  fi
}

# first_exec_line <file> — the first line that is neither blank nor a comment
# (the shebang is a comment).
first_exec_line() {
  awk '/^[[:space:]]*$/ { next } /^[[:space:]]*#/ { next } { print; exit }' "$1"
}

# canonical_line_for <file> — the guard line a fixture in that directory must
# carry. Returns 1 for a file outside the population.
canonical_line_for() {
  case "$1" in
    */cli/tests/integration/*.bats) printf '%s\n' "$CLI_GUARD_LINE" ;;
    */test/*.test.bash) printf '%s\n' "$ROOT_GUARD_LINE" ;;
    *) return 1 ;;
  esac
}

guard_present() {
  local want
  want="$(canonical_line_for "$1")" || return 1
  [ "$(first_exec_line "$1")" = "$want" ]
}

# fixture_population — derived from the two globs, never hand-listed.
fixture_population() {
  local f
  for f in "$IGRIS_ROOT"/test/*.test.bash "$IGRIS_ROOT"/cli/tests/integration/*.bats; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
  return 0
}

# The belt under both spawn helpers: the leak is real in THIS process (else
# the unset proves nothing) and `env -u` removes it in the child.
assert_unset_takes_effect() {
  local here child
  # shellcheck disable=SC2016
  here="$(bash -c 'printf %s "${BATS_TEST_DIRNAME-UNSET}"')"
  # shellcheck disable=SC2016
  child="$(env -u BATS_TEST_DIRNAME bash -c 'printf %s "${BATS_TEST_DIRNAME-UNSET}"')"
  if [ "$here" = "UNSET" ]; then
    echo "precondition: BATS_TEST_DIRNAME is not exported to children here, so the unset is unproven" >&2
    return 1
  fi
  if [ "$child" != "UNSET" ]; then
    echo "precondition: env -u did not unset BATS_TEST_DIRNAME (the child saw '$child')" >&2
    return 1
  fi
}

# run_plain_bash <file> — an operator's plain `bash <file>`.
run_plain_bash() {
  assert_unset_takes_effect || return 1
  run env -u BATS_VERSION -u BATS_TEST_DIRNAME \
    HOME="$CHILD_HOME" GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR" \
    bash "$1" </dev/null
}

# run_nested_bash <file> — a plain `bash <file>` spawned from inside a bats
# run: BATS_VERSION is inherited, `load` is not.
run_nested_bash() {
  assert_unset_takes_effect || return 1
  run env -u BATS_TEST_DIRNAME \
    HOME="$CHILD_HOME" GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR" \
    bash "$1" </dev/null
}

# assert_refused — the three-part refusal assertion on the last `run`.
assert_refused() {
  if [ "$status" -ne 2 ]; then
    echo "expected exit 2 (refusal), got $status. output: $output" >&2
    return 1
  fi
  assert_contains "$output" "$REFUSAL" || return 1
  assert_not_contains "$output" "No such file" || return 1
}

# make_dirty_repo — a scratch git repo with one untracked file and no commits.
make_dirty_repo() {
  git -C "${SCRATCH:?}" init -q
  git -C "${SCRATCH:?}" config user.name fixture-guard
  git -C "${SCRATCH:?}" config user.email fixture-guard@example.invalid
  git -C "${SCRATCH:?}" config core.hooksPath /dev/null
  echo x > "$SCRATCH/dirty.txt"
}

assert_repo_untouched() {
  local commits porcelain
  commits="$(git -C "${SCRATCH:?}" rev-list --all --count)"
  porcelain="$(git -C "${SCRATCH:?}" status --porcelain)"
  if [ "$commits" != "0" ] || [ "$porcelain" != "?? dirty.txt" ]; then
    echo "the scratch repo changed: commits=$commits porcelain=[$porcelain]" >&2
    return 1
  fi
}

# write_synthetic_fixture <dir> — a fixture carrying the test/ canonical line.
# Its top level creates $MARKER.top (runs only if the guard lets it through);
# its @test creates $MARKER.test (runs only under bats).
write_synthetic_fixture() {
  mkdir -p "$1"
  {
    printf '%s\n' '#!/usr/bin/env bats'
    printf '%s\n' "$ROOT_GUARD_LINE"
    # shellcheck disable=SC2016
    printf '%s\n' 'touch "${MARKER:?}.top"'
    printf '%s\n' '@test "synthetic body" {'
    # shellcheck disable=SC2016
    printf '%s\n' '  touch "${MARKER:?}.test"'
    printf '%s\n' '}'
  } > "$1/synthetic.test.bash"
}

# -----------------------------------------------------------------------------
# G1 (AC1/AC5) — the incident file, under an operator's plain bash, inside a
# scratch repo holding uncommitted work.
# -----------------------------------------------------------------------------
@test "G1: the incident fixture refuses under plain bash and the scratch repo is untouched" {
  local f="$INCIDENT_FIXTURE"
  guard_present "$f" || { echo "guard absent: $f (not executed)" >&2; return 1; }
  make_dirty_repo
  run_plain_bash "$f"
  assert_refused || return 1
  assert_contains "$output" "bats $f" || return 1
  assert_repo_untouched || return 1
}

# -----------------------------------------------------------------------------
# G1b — the same for a CLI fixture that carries add + commit. Its source path is
# the one an inherited BATS_TEST_DIRNAME breaks (see the header).
# -----------------------------------------------------------------------------
@test "G1b: a CLI fixture (home-fence.bats) refuses under plain bash, repo untouched" {
  local f="$CLI_ANCHOR_FIXTURE"
  guard_present "$f" || { echo "guard absent: $f (not executed)" >&2; return 1; }
  make_dirty_repo
  run_plain_bash "$f"
  assert_refused || return 1
  assert_contains "$output" "bats $f" || return 1
  assert_repo_untouched || return 1
}

# -----------------------------------------------------------------------------
# G2 — nested: a plain bash spawned from inside this bats run inherits
# BATS_VERSION, so only the `load` arm can refuse it. A root AND a CLI fixture,
# so a CLI source-path failure can never pass G2.
# -----------------------------------------------------------------------------
@test "G2: nested plain bash (BATS_VERSION inherited) refuses, root and CLI fixture" {
  local inherited
  # shellcheck disable=SC2016
  inherited="$(bash -c 'printf %s "${BATS_VERSION-}"')"
  [ -n "$inherited" ] || { echo "precondition: BATS_VERSION is not exported to children" >&2; return 1; }
  local f
  for f in "$INCIDENT_FIXTURE" "$CLI_ANCHOR_FIXTURE"; do
    guard_present "$f" || { echo "guard absent: $f (not executed)" >&2; return 1; }
    run_nested_bash "$f"
    assert_refused || { echo "fixture: $f" >&2; return 1; }
  done
}

# -----------------------------------------------------------------------------
# G2m — self-negative for the `load` arm. The SAME synthetic fixture runs
# nested twice: next to a copy of the real guard it is refused; next to a sed
# mutant without the `declare -F load` arm its top level executes. So G2's
# refusal comes from that arm. BATS_TEST_DIRNAME must be unset here too, or the
# synthetic line would resolve to the REAL guard in test/ and refuse.
# -----------------------------------------------------------------------------
@test "G2m: without the load arm, a nested plain bash runs the fixture (self-negative)" {
  local real="$BATS_TEST_TMPDIR/fx2real" mut="$BATS_TEST_TMPDIR/fx2mut"
  write_synthetic_fixture "$real"
  write_synthetic_fixture "$mut"
  cp "$IGRIS_ROOT/test/require_bats.bash" "$real/require_bats.bash"
  sed 's/ || ! declare -F load >\/dev\/null 2>&1//' \
    "$IGRIS_ROOT/test/require_bats.bash" > "$mut/require_bats.bash"
  if cmp -s "$real/require_bats.bash" "$mut/require_bats.bash"; then
    echo "MUTANT NOT PLANTED: the load arm text was not found in require_bats.bash" >&2
    return 1
  fi
  if grep -F 'declare -F load' "$mut/require_bats.bash" >/dev/null; then
    echo "MUTANT NOT PLANTED: the mutant still tests declare -F load" >&2
    return 1
  fi

  export MARKER="$BATS_TEST_TMPDIR/g2m-real"
  run_nested_bash "$real/synthetic.test.bash"
  assert_refused || return 1
  [ ! -e "$MARKER.top" ] || { echo "the real guard let the top level run" >&2; return 1; }

  export MARKER="$BATS_TEST_TMPDIR/g2m-mut"
  run_nested_bash "$mut/synthetic.test.bash"
  [ -e "$MARKER.top" ] || { echo "the mutant still blocked the fixture: $output" >&2; return 1; }
  assert_not_contains "$output" "$REFUSAL" || return 1
}

# -----------------------------------------------------------------------------
# G3 (AC1 population, static) — every fixture's first executable line is its
# directory's canonical guard line, byte-identical.
# -----------------------------------------------------------------------------
@test "G3: every fixture's first executable line is the canonical guard line" {
  local f n=0 bad="" nbad=0 pop=""
  while IFS= read -r f; do
    n=$((n + 1))
    pop="$pop"$'\n'"$f"
    if ! guard_present "$f"; then
      nbad=$((nbad + 1))
      bad="$bad"$'\n'"  ${f#"$IGRIS_ROOT"/}: [$(first_exec_line "$f")]"
    fi
  done < <(fixture_population)

  [ "$n" -gt 0 ] || { echo "empty fixture population" >&2; return 1; }
  assert_contains "$pop"$'\n' $'\n'"$INCIDENT_FIXTURE"$'\n' || return 1
  assert_contains "$pop"$'\n' $'\n'"$CLI_ANCHOR_FIXTURE"$'\n' || return 1

  # Cross-check the population definition: no OTHER non-doc file under the two
  # directories holds an @test (a fixture the globs would miss).
  local stray=""
  while IFS= read -r f; do
    case "$pop"$'\n' in
      *$'\n'"$f"$'\n'*) ;;
      *) stray="$stray"$'\n'"  ${f#"$IGRIS_ROOT"/}" ;;
    esac
  done < <(find "$IGRIS_ROOT/test" "$IGRIS_ROOT/cli/tests/integration" -type f ! -name '*.md' \
             -exec grep -l '^@test' {} + 2>/dev/null || true)
  [ -z "$stray" ] || { echo "files with @test outside the population:$stray" >&2; return 1; }

  if [ -n "$bad" ]; then
    echo "$nbad of $n fixtures do not start with their canonical guard line (first executable line shown):$bad" >&2
    return 1
  fi
}

# -----------------------------------------------------------------------------
# G4 (AC1 population, dynamic) — every guarded fixture, run as an operator's
# plain bash, is refused (the three-part assertion). A fixture failing G3 is
# never executed and is reported here too, so G4 cannot pass by skipping.
# -----------------------------------------------------------------------------
@test "G4: every fixture refuses under plain bash (exit 2 + refusal literal + no 'No such file')" {
  local f n=0 fails="" nfail=0
  while IFS= read -r f; do
    n=$((n + 1))
    if ! guard_present "$f"; then
      nfail=$((nfail + 1))
      fails="$fails"$'\n'"  ${f#"$IGRIS_ROOT"/}: NOT EXECUTED (guard absent, see G3)"
      continue
    fi
    run_plain_bash "$f"
    if [ "$status" -ne 2 ] || [[ "$output" != *"$REFUSAL"* ]] || [[ "$output" == *"No such file"* ]]; then
      nfail=$((nfail + 1))
      fails="$fails"$'\n'"  ${f#"$IGRIS_ROOT"/}: status=$status first line=[${output%%$'\n'*}]"
    fi
  done < <(fixture_population)
  [ "$n" -gt 0 ] || { echo "empty fixture population" >&2; return 1; }
  if [ -n "$fails" ]; then
    echo "$nfail of $n fixtures were not refused:$fails" >&2
    return 1
  fi
}

# -----------------------------------------------------------------------------
# G4n — negative control for G4's assertions. Reproduce the leak on purpose: a
# CLI fixture under plain bash with BATS_TEST_DIRNAME pointing at test/. The
# run is fail-closed (exit 2, the body never ran) but it is NOT a refusal, and
# assert_refused must reject it. A status-only assertion would accept it.
# -----------------------------------------------------------------------------
@test "G4n: a mis-resolved guard path exits 2 but is not accepted as a refusal" {
  local f="$IGRIS_ROOT/cli/tests/integration/version.bats"
  guard_present "$f" || { echo "guard absent: $f (not executed)" >&2; return 1; }
  [ ! -e "$IGRIS_ROOT/test/../../../test/require_bats.bash" ] || {
    echo "precondition: the leaked path unexpectedly exists, so it cannot mis-resolve" >&2; return 1; }
  run env -u BATS_VERSION BATS_TEST_DIRNAME="$IGRIS_ROOT/test" \
    HOME="$CHILD_HOME" GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR" \
    bash "$f" </dev/null
  [ "$status" -eq 2 ] || { echo "expected 2, got $status: $output" >&2; return 1; }
  assert_contains "$output" "No such file" || return 1
  assert_not_contains "$output" "$REFUSAL" || return 1
  if assert_refused 2>/dev/null; then
    echo "assert_refused ACCEPTED a mis-resolved source path as a refusal" >&2
    return 1
  fi
}

# -----------------------------------------------------------------------------
# G5 (AC2, static, OCCURRENCE level) — no `git -C` argument in the fixture set
# is a lone expansion that can be empty ($V, ${V}, ${V:-…}, $(…), $1, $V$W,
# quoted or not, including inside `bash -c` strings). Allowed: ${V:?…}, or any
# argument with a literal character outside its expansions ($V/sub).
#
# scan_git_C <files…> prints one `BAD<TAB>file:line<TAB>argument` per forbidden
# occurrence (every occurrence on a line, not the first), then one
# `TOTAL<TAB><occurrences><TAB><lines>` line.
# -----------------------------------------------------------------------------
scan_git_C() {
  awk '
    # Remove every expansion from s: ${…} and $(…) (nested), $NAME, $N,
    # the specials, and `…` command substitutions. What is left is literal.
    function strip_expansions(s,    out, i, j, n, c, c2, d, cj) {
      out = ""; n = length(s); i = 1
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "$" && i < n) {
          c2 = substr(s, i + 1, 1)
          if (c2 == "{" || c2 == "(") {
            d = 0
            for (j = i + 1; j <= n; j++) {
              cj = substr(s, j, 1)
              if (cj == "{" || cj == "(") d++
              else if (cj == "}" || cj == ")") { d--; if (d == 0) break }
            }
            i = j + 1; continue
          }
          if (c2 ~ /[A-Za-z_]/) {
            for (j = i + 1; j <= n && substr(s, j, 1) ~ /[A-Za-z0-9_]/; j++) ;
            i = j; continue
          }
          if (c2 ~ /[0-9@*#?$!-]/) { i += 2; continue }
        }
        if (c == "`") {
          j = index(substr(s, i + 1), "`")
          if (j > 0) { i += j + 1; continue }
        }
        out = out c; i++
      }
      return out
    }
    # The shell word that starts s: ends at unquoted, un-nested whitespace or
    # a control operator.
    function take_arg(s,    out, i, n, c, q, d) {
      out = ""; n = length(s); q = ""; d = 0
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (q == "" && d == 0 && c ~ /[[:space:];&|<>)]/) break
        out = out c
        if (q != "") { if (c == q) q = ""; else if (c == "$" && substr(s, i + 1, 1) ~ /[{(]/) d++; else if (c ~ /[})]/ && d > 0) d--; continue }
        if (c == "\"" || c == "\047") { q = c; continue }
        if (c == "$" && substr(s, i + 1, 1) ~ /[{(]/) { d++; continue }
        if (c ~ /[})]/ && d > 0) d--
      }
      return out
    }
    {
      line = $0
      gsub(/\\/, "", line)            # \" and \$ inside a bash -c string
      rest = line; hit = 0
      while (match(rest, /git[[:space:]]+-C[[:space:]]+/)) {
        pre = (RSTART > 1) ? substr(rest, RSTART - 1, 1) : ""
        after = substr(rest, RSTART + RLENGTH)
        rest = after
        if (pre ~ /[A-Za-z0-9_.-]/) continue      # e.g. `mygit -C`
        occ++; hit = 1
        arg = take_arg(after)
        lit = arg
        gsub(/["\047]/, "", lit)
        lit = strip_expansions(lit)
        if (lit == "" && arg !~ /\$\{[A-Za-z_][A-Za-z0-9_]*:\?/) {
          printf "BAD\t%s:%d\t%s\n", FILENAME, FNR, arg
        }
      }
      if (hit) lines++
    }
    END { printf "TOTAL\t%d\t%d\n", occ, lines }
  ' "$@"
}

fixture_script_files() {
  local f
  for f in "$IGRIS_ROOT"/test/*.bash "$IGRIS_ROOT"/cli/tests/integration/*.bash \
           "$IGRIS_ROOT"/cli/tests/integration/*.bats; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
  return 0
}

@test "G5: no git -C argument in the fixture set can expand to an empty path" {
  local files=() f
  while IFS= read -r f; do files+=("$f"); done < <(fixture_script_files)
  [ "${#files[@]}" -gt 0 ] || { echo "no fixture files found" >&2; return 1; }
  run scan_git_C "${files[@]}"
  [ "$status" -eq 0 ] || { echo "scanner failed: $output" >&2; return 1; }
  local bad total
  bad="$(printf '%s\n' "$output" | awk -F'\t' '$1 == "BAD" { printf "  %s  %s\n", $2, $3 }')"
  total="$(printf '%s\n' "$output" | awk -F'\t' '$1 == "TOTAL" { print $2 " occurrences on " $3 " lines" }')"
  # The scan must actually have seen the population it rules on.
  [ -n "$total" ] || { echo "the scanner printed no TOTAL line" >&2; return 1; }
  case "$total" in 0\ *) echo "the scanner saw 0 git -C occurrences" >&2; return 1 ;; esac
  if [ -n "$bad" ]; then
    echo "git -C arguments that can expand to an empty path ($total scanned):" >&2
    echo "$bad" >&2
    return 1
  fi
}

# G5's self-negative: every forbidden shape is flagged, every allowed shape is
# not, and a line whose FIRST occurrence is allowed and SECOND forbidden is
# flagged (a first-match-per-line scan would miss it). The plants are built
# with printf so this file itself holds no forbidden literal.
@test "G5 self-negative: planted forbidden shapes are flagged, allowed shapes are not" {
  local g='git' c='-C' plant="$BATS_TEST_TMPDIR/plants.bash"
  {
    # 1-9: forbidden
    printf '%s %s "$V" status\n' "$g" "$c"
    printf '%s %s "${V}" status\n' "$g" "$c"
    printf '%s %s "${V:-}" status\n' "$g" "$c"
    printf '%s %s "$(pwd)" status\n' "$g" "$c"
    printf '%s %s "$1" status\n' "$g" "$c"
    printf '%s %s "$V$W" status\n' "$g" "$c"
    printf '%s %s $V status\n' "$g" "$c"
    printf 'bash -c "cd x && %s %s '"'"'$SBX'"'"' log"\n' "$g" "$c"
    printf '%s %s "$V/sub" log && %s %s "$W" log\n' "$g" "$c" "$g" "$c"
    # 10-13: allowed
    printf '%s %s "${V:?}" status\n' "$g" "$c"
    printf '%s %s "${V:?unset}" status\n' "$g" "$c"
    printf '%s %s "$V/sub" status\n' "$g" "$c"
    printf 'bash -c "%s %s '"'"'${SBX:?}'"'"' log"\n' "$g" "$c"
  } > "$plant"
  run scan_git_C "$plant"
  [ "$status" -eq 0 ] || return 1
  local ln T=$'\t'
  for ln in 1 2 3 4 5 6 7 8 9; do
    assert_contains "$output" "BAD${T}$plant:$ln${T}" || { echo "forbidden plant $ln not flagged" >&2; return 1; }
  done
  for ln in 10 11 12 13; do
    assert_not_contains "$output" "BAD${T}$plant:$ln${T}" || { echo "allowed plant $ln flagged" >&2; return 1; }
  done
  # Line 9's flagged argument is the SECOND occurrence ("$W"), not the first.
  assert_contains "$output" "BAD${T}$plant:9${T}\"\$W\"" || return 1
  assert_contains "$output" "TOTAL${T}14${T}13" || return 1
}

# -----------------------------------------------------------------------------
# G5b — under bats, `git -C "${EMPTY:?}"` fails the test before git runs. A
# stub `git` on PATH records any invocation; the control run proves the stub
# is wired.
# -----------------------------------------------------------------------------
@test "G5b: an empty \${V:?} path fails the test and git never runs" {
  local fx="$BATS_TEST_TMPDIR/fx5" stub="$BATS_TEST_TMPDIR/stubbin"
  mkdir -p "$fx" "$stub"
  cp "$IGRIS_ROOT/test/require_bats.bash" "$fx/require_bats.bash"
  # shellcheck disable=SC2016
  printf '#!/bin/sh\ntouch "$GIT_STUB_MARKER"\nexit 0\n' > "$stub/git"
  chmod +x "$stub/git"
  {
    printf '%s\n' '#!/usr/bin/env bats'
    printf '%s\n' "$ROOT_GUARD_LINE"
    printf '%s\n' '@test "empty -C path" {'
    # shellcheck disable=SC2016
    printf '%s\n' '  git -C "${EMPTY_PATH:?}" status'
    printf '%s\n' '}'
  } > "$fx/empty.test.bash"

  export GIT_STUB_MARKER="$BATS_TEST_TMPDIR/git-ran"
  run env -u BATS_TEST_DIRNAME PATH="$stub:$PATH" EMPTY_PATH= HOME="$CHILD_HOME" bats "$fx/empty.test.bash"
  [ "$status" -ne 0 ] || { echo "the bats run passed with an empty path: $output" >&2; return 1; }
  [ ! -e "$GIT_STUB_MARKER" ] || { echo "git ran with an empty -C path" >&2; return 1; }

  # Control: a non-empty value reaches the stub.
  run env -u BATS_TEST_DIRNAME PATH="$stub:$PATH" EMPTY_PATH="$SCRATCH" HOME="$CHILD_HOME" bats "$fx/empty.test.bash"
  [ "$status" -eq 0 ] || { echo "control run failed: $output" >&2; return 1; }
  [ -e "$GIT_STUB_MARKER" ] || { echo "control: the stub git never ran, so the red run proves nothing" >&2; return 1; }
}

# -----------------------------------------------------------------------------
# G6 — self-negative for the whole guard: next to a sed mutant with the check
# removed, the synthetic fixture's top level EXECUTES under plain bash. So G1's
# refusal comes from the guard. (BATS_TEST_DIRNAME unset, as in G2m.)
# -----------------------------------------------------------------------------
@test "G6: with the check removed, a plain bash runs the fixture (self-negative)" {
  local mut="$BATS_TEST_TMPDIR/fx6"
  write_synthetic_fixture "$mut"
  # Neutralise the predicate: `if false; then … fi` never refuses.
  sed 's/^if \[ -z .*; then$/if false; then/' \
    "$IGRIS_ROOT/test/require_bats.bash" > "$mut/require_bats.bash"
  if cmp -s "$IGRIS_ROOT/test/require_bats.bash" "$mut/require_bats.bash" \
     || ! grep -x 'if false; then' "$mut/require_bats.bash" >/dev/null; then
    echo "MUTANT NOT PLANTED: the predicate line was not found in require_bats.bash" >&2
    return 1
  fi
  export MARKER="$BATS_TEST_TMPDIR/g6"
  run_plain_bash "$mut/synthetic.test.bash"
  [ -e "$MARKER.top" ] || { echo "the mutant still blocked the fixture: $output" >&2; return 1; }
  assert_not_contains "$output" "$REFUSAL" || return 1
}

# -----------------------------------------------------------------------------
# G7 — positive control: next to a copy of the REAL guard, the synthetic fixture
# passes under bats and its @test body runs. The guard never blocks bats. bats
# sets BATS_TEST_DIRNAME for the file it runs even when a foreign value is
# exported, so no unset is needed here.
# -----------------------------------------------------------------------------
@test "G7: the real guard does not block a legitimate bats run" {
  local fx="$BATS_TEST_TMPDIR/fx7"
  write_synthetic_fixture "$fx"
  cp "$IGRIS_ROOT/test/require_bats.bash" "$fx/require_bats.bash"
  export MARKER="$BATS_TEST_TMPDIR/g7"
  run bats "$fx/synthetic.test.bash"
  [ "$status" -eq 0 ] || { echo "bats run failed: $output" >&2; return 1; }
  [ -e "$MARKER.test" ] || { echo "the @test body did not run" >&2; return 1; }
  assert_not_contains "$output" "$REFUSAL" || return 1
}
