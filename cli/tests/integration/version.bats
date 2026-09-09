#!/usr/bin/env bats

# version.bats — proves the CLI binary exec'd via node prints its version
# and exits 0. Smoke test for the bats harness itself.

load _helpers.bash

# TD-456: nothing here writes (`install --help` exits in commander before
# runInstall), but every file that names install/init runs fenced.
setup() {
  fence_home
}

@test "igris --version prints semver and exits 0" {
  run $CLI_BIN --version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "igris install --help exits 0" {
  run $CLI_BIN install --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "install" ]]
}

@test "igris doctor --help exits 0" {
  run $CLI_BIN doctor --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "doctor" ]]
}

@test "igris update --help exits 0" {
  run $CLI_BIN update --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "update" ]]
}
