#!/usr/bin/env bats

# tarball-zip-slip.bats — integration test for the malicious-tarball
# rejection path. We can't easily wire the CLI to fetch a tarball
# from a local file (the verb expects an HTTPS URL); the unit test in
# src/__tests__/tarball.test.ts already verifies the rejection path
# end-to-end against the committed fixture. This bats test is a
# narrower belt-and-braces check at the CLI surface.
#
# What we verify:
#   1. The malicious fixture exists at the expected path.
#   2. The unit-test entry point passes (i.e. zip-slip rejection still
#      green when run via npm test from the repo root). We invoke
#      npx vitest with the specific file so a regression here surfaces
#      at the CLI integration boundary, not just at unit-test layer.
#   3. The malicious fixture's contents include both the `..` escape
#      and the absolute path entry (defending against fixture drift).

load _helpers.bash

setup() {
  # _helpers.bash defines CLI_DIST as <cli>/dist; from there ../src/__tests__/fixtures/...
  ZIPSLIP_TARBALL="$(cd "$CLI_DIST/.." && pwd)/src/__tests__/fixtures/tarballs/zip-slip.tar.gz"
}

@test "malicious zip-slip fixture is present" {
  [ -f "$ZIPSLIP_TARBALL" ]
}

@test "zip-slip fixture contains a ../ escape entry" {
  run tar -tzf "$ZIPSLIP_TARBALL"
  [ "$status" -eq 0 ]
  [[ "$output" == *"../etc/passwd"* ]]
}

@test "zip-slip fixture contains an absolute-path entry" {
  run tar -tzf "$ZIPSLIP_TARBALL"
  [ "$status" -eq 0 ]
  [[ "$output" == *"/tmp/igris-zip-slip-pwn"* ]]
}

@test "zip-slip rejection unit test passes (CRITICAL gate)" {
  cd "$CLI_DIST/.."
  # TD-434 (2026-08-31): `--reporter=verbose` is load-bearing — vitest 4's
  # default reporter prints only the run summary to a non-TTY (zero per-test
  # names), so the describe-name needle below could never match (CI red:
  # runs 33085032612 → 33388050967, `[[ "$output" == *"zip-slip rejection"* ]]'
  # failed`). The test still passed locally because a non-final bare [[ ]]
  # is vacuous under Bats 1.12.0 (TD-341's class) — hence the `|| return 1`
  # arms, which keep every assertion armed on every bats version.
  run npx vitest run --reporter=verbose src/__tests__/tarball.test.ts
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"zip-slip rejection"* ]] || return 1
  [[ "$output" == *"passed"* ]] || return 1
}
