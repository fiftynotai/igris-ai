#!/usr/bin/env bash
# require_bats.bash — TD-348: a bats fixture refuses to run under plain `bash`.
#
# Every fixture in test/*.test.bash and cli/tests/integration/*.bats sources
# this file as its FIRST executable line, through the one canonical line for
# its directory (test/fixture_bats_guard.test.bash pins both byte-for-byte):
#
#   test/:
#     source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
#   cli/tests/integration/:
#     source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../../../test/require_bats.bash" || exit 2
#
# THE INCIDENT (2026-08-05). `bash test/check_contract_consumers.test.bash`
# was run instead of `bats …`. Under plain bash, `setup()` is defined and never
# called, so `$REPO` was empty, and the first @test body's `add -A` and
# `commit` reached git with an EMPTY `-C` path. An empty `-C` is not an error:
# git runs in the current directory. The fixture swept 12 files of in-flight
# work into a real commit (270db43) on the checkout it was launched from.
#
# WHY THIS KEYS ON BATS BEING PRESENT, NOT ON `${REPO:?}`. A top-level
# `: "${REPO:?}"` would abort every LEGITIMATE bats run: bats sources the file
# to gather its tests before any `setup()` has assigned the sandbox. What is
# actually wrong under plain bash is that the harness is absent, so that is what
# the predicate tests. Both arms must hold:
#   1. BATS_VERSION is non-empty. The `bats` launcher exports it.
#   2. `load` is a shell function in THIS shell. bats defines it in every phase
#      that sources a fixture (gather, exec-file, exec-test, exec-suite). It is
#      a function, so it is never exported. That makes it the arm that catches
#      a plain `bash <fixture>` spawned from INSIDE a bats run: the child
#      inherits the exported BATS_VERSION, but not `load`.
# The fixture-level complement is that every `-C` path is written `"${V:?}"`
# (never a bare "$V"), so an empty path fails at expansion time even where this
# guard is not in play (test/fixture_bats_guard.test.bash G5 enforces it).
#
# WHY `exit` AND NOT `return`. This file is sourced at the top level of the
# fixture. `return` would leave only this file, and the fixture would carry on
# executing its @test bodies as plain top-level code — the incident. `exit 2`
# ends the whole shell before any fixture line after the guard runs.
#
# ONE HAZARD, fail-closed but without this message. An EXPORTED
# BATS_TEST_DIRNAME from somewhere else (test/test_helper.bash exports it, so a
# test that loads test_helper and then spawns `bash <fixture>` passes it on)
# replaces the `dirname "${BASH_SOURCE[0]}"` fallback in the canonical line. A
# root fixture still finds this file (the exported value is the test/ dir). A
# CLI fixture resolves `<that dir>/../../../test/require_bats.bash`, which does
# not exist: `source` fails with "No such file or directory", the line's
# `|| exit 2` fires, and the fixture body never runs — but the hint below is
# not printed. A test that spawns a fixture with plain bash must therefore
# unset BATS_TEST_DIRNAME in the child (`env -u BATS_TEST_DIRNAME bash <f>`).
#
# Exit code: 2 (usage error — the file was run the wrong way). The first line
# on stderr always begins with the literal `require_bats: refusing to run`.

if [ -z "${BATS_VERSION:-}" ] || ! declare -F load >/dev/null 2>&1; then
  {
    printf 'require_bats: refusing to run %s outside bats (TD-348).\n' "${BASH_SOURCE[1]:-$0}"
    printf 'require_bats: this file is a bats fixture; its setup() never runs under plain bash, so its sandbox paths are empty.\n'
    printf 'require_bats: run it with:  bats %s\n' "${BASH_SOURCE[1]:-$0}"
  } >&2
  exit 2
fi
