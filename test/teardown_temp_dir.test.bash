#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# teardown_temp_dir.test.bash — TD-481. Every root suite that overrides
# teardown() must remove its TEST_TEMP_DIR, through ONE guarded helper.
#
# WHY. test/test_helper.bash mints a fresh `mktemp` root per @test (TD-394) and
# its default teardown() removes it. A suite that defines its own teardown()
# after `load test_helper` REPLACES that default, so the root leaked unless the
# override removed it too. Census 2026-10-01 (b88bfaf): 38 files override
# teardown(), 2 removed the root, 36 leaked; one full `bats test/*.test.bash`
# left 156 non-empty `igris-test-*` roots behind (TMPDIR free of exempt tokens,
# marker-file `find`). The fix is `cleanup_test_temp_dir`, called as the LAST
# statement of every override.
#
# G1  every override in test/ ends with `cleanup_test_temp_dir` (static scan,
#     failures named by file);
# G2  the scan is not vacuous — it found the override population;
# G3  a planted override WITHOUT the call is reported (negative control);
# G4  a planted override WITH the call is silent (positive control);
# H1-H5  the helper removes a real root, and nothing else, and never fails.
#
# H2/H3 shadow `rm` with a recording function inside a subshell, so a mutated
# helper (guard dropped) can never reach a real `rm -rf` of "/" or "".
#
# Known residual, reported not failed: bats also SOURCES each file outside any
# @test, where test_helper's `mktemp` runs too, leaving EMPTY roots (599 in the
# 2026-10-01 baseline run). The AC counts non-empty roots (`! -empty`).

load test_helper

# scan_teardowns <dir> — one `LEAK <file>` line per teardown() body whose last
# statement is not `cleanup_test_temp_dir`, then `SCANNED <n>` (the number of
# files that define teardown()). A body runs from `teardown()` to the first
# line starting with `}`; a one-line `teardown() { …; }` is its own body.
# Comment and blank lines are not statements.
scan_teardowns() {
  local root="$1" f n=0
  for f in "$root"/*.test.bash; do
    [ -f "$f" ] || continue
    grep -q '^teardown()' "$f" || continue
    n=$((n + 1))
    awk -v F="${f##*/}" '
      function close_body() { if (last !~ /cleanup_test_temp_dir[[:space:];]*$/) print "LEAK " F; inb = 0 }
      /^teardown\(\)/ {
        inb = 1; last = ""
        if ($0 ~ /}[[:space:]]*$/) { last = $0; sub(/}[[:space:]]*$/, "", last); close_body() }
        next
      }
      inb && /^}/ { close_body(); next }
      inb && $0 !~ /^[[:space:]]*(#|$)/ { last = $0 }
    ' "$f"
  done
  echo "SCANNED $n"
}

@test "G1: every teardown() override in test/ ends with cleanup_test_temp_dir" {
  run scan_teardowns "${TEARDOWN_SCAN_ROOT:-$BATS_TEST_DIRNAME}"
  [ "$status" -eq 0 ]
  leaks="$(printf '%s\n' "$output" | grep '^LEAK ' || true)"
  if [ -n "$leaks" ]; then
    echo "overrides that do not end with cleanup_test_temp_dir (their TEST_TEMP_DIR leaks):" >&2
    echo "$leaks" >&2
    return 1
  fi
}

@test "G2: the scan is not vacuous — it found the teardown() override population" {
  run scan_teardowns "$BATS_TEST_DIRNAME"
  n="$(printf '%s\n' "$output" | sed -n 's/^SCANNED //p')"
  echo "SCANNED=$n" >&2
  # count:record TD-481 — 38 overriding files on 2026-10-01. The floor sits
  # below that so retiring a few suites stays green, and far above 0, which
  # is what a broken glob or a renamed `teardown()` pattern would scan.
  [ -n "$n" ]
  [ "$n" -ge 30 ]
}

@test "G3: a planted override WITHOUT the call is reported (negative control)" {
  d="$BATS_TEST_TMPDIR/scan-neg"
  mkdir -p "$d"
  printf 'load test_helper\nteardown() {\n  rm -rf "$SANDBOX"\n  # cleanup_test_temp_dir (a comment is not a call)\n}\n' > "$d/leaky.test.bash"
  printf 'load test_helper\nteardown() {\n  cleanup_test_temp_dir\n  rm -rf "$SANDBOX"\n}\n' > "$d/wrong_order.test.bash"
  printf 'load test_helper\nteardown() { rm -rf "$SANDBOX"; }\n' > "$d/oneline.test.bash"
  run env TEARDOWN_SCAN_ROOT="$d" bash -c "$(declare -f scan_teardowns); scan_teardowns \"\$TEARDOWN_SCAN_ROOT\""
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -qx 'LEAK leaky.test.bash'
  printf '%s\n' "$output" | grep -qx 'LEAK wrong_order.test.bash'
  printf '%s\n' "$output" | grep -qx 'LEAK oneline.test.bash'
  printf '%s\n' "$output" | grep -qx 'SCANNED 3'
}

@test "G4: a planted override WITH the call is silent (positive control)" {
  d="$BATS_TEST_TMPDIR/scan-pos"
  mkdir -p "$d"
  printf 'load test_helper\nteardown() {\n  rm -rf "$SANDBOX"\n  cleanup_test_temp_dir\n}\n' > "$d/good.test.bash"
  printf 'load test_helper\nteardown() {\n  [ -n "${X:-}" ] && rm -rf "$X"; cleanup_test_temp_dir\n}\n' > "$d/same_line.test.bash"
  printf 'load test_helper\n@test "x" { true; }\n' > "$d/no_override.test.bash"
  run scan_teardowns "$d"
  [ "$status" -eq 0 ]
  [ "$output" = "SCANNED 2" ]
}

@test "H1: a real igris-test-* root is removed, and the return is 0" {
  root="$(mktemp -d "$BATS_TEST_TMPDIR/igris-test-XXXXXX")"
  mkdir -p "$root/fixture/nested"
  touch "$root/fixture/nested/file"
  run bash -c "$(declare -f cleanup_test_temp_dir); TEST_TEMP_DIR='$root' cleanup_test_temp_dir"
  [ "$status" -eq 0 ]
  [ ! -e "$root" ]
}

@test "H2: an EMPTY TEST_TEMP_DIR removes nothing and returns 0" {
  log="$BATS_TEST_TMPDIR/rm.log"
  run bash -c "rm() { echo \"rm \$*\" >> '$log'; }; $(declare -f cleanup_test_temp_dir); TEST_TEMP_DIR='' cleanup_test_temp_dir"
  [ "$status" -eq 0 ]
  [ ! -e "$log" ]
}

@test "H3: TEST_TEMP_DIR=/ removes nothing (the basename guard), returns 0" {
  log="$BATS_TEST_TMPDIR/rm.log"
  run bash -c "rm() { echo \"rm \$*\" >> '$log'; }; $(declare -f cleanup_test_temp_dir); TEST_TEMP_DIR=/ cleanup_test_temp_dir"
  [ "$status" -eq 0 ]
  [ ! -e "$log" ]
}

@test "H4: a foreign directory (not igris-test-*) survives" {
  foreign="$BATS_TEST_TMPDIR/not-ours"
  mkdir -p "$foreign"
  touch "$foreign/keep"
  run bash -c "$(declare -f cleanup_test_temp_dir); TEST_TEMP_DIR='$foreign' cleanup_test_temp_dir"
  [ "$status" -eq 0 ]
  [ -f "$foreign/keep" ]
}

@test "H5: an already-removed root returns 0 (a teardown must not fail on it)" {
  root="$(mktemp -d "$BATS_TEST_TMPDIR/igris-test-XXXXXX")"
  rmdir "$root"
  run bash -c "$(declare -f cleanup_test_temp_dir); TEST_TEMP_DIR='$root' cleanup_test_temp_dir"
  [ "$status" -eq 0 ]
}

@test "the default teardown() in test_helper calls the helper (one rule, not two)" {
  body="$(awk '/^teardown\(\)/{f=1} f{print} f&&/^}/{exit}' "$BATS_TEST_DIRNAME/test_helper.bash")"
  printf '%s\n' "$body" | grep -q '^  cleanup_test_temp_dir$'
}
