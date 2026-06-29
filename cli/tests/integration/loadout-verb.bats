#!/usr/bin/env bats

# loadout-verb.bats — FR-216: the Layer-2 customization store verb is `igris
# loadout`. Proves the rename landed cleanly with NO back-compat:
#   - `igris loadout` exists (--help + list work)
#   - `igris registry` is GONE outright (clean break — NO deprecated alias)
#
# The Layer-2 store is UNRELATED to the project registry (`igris install` /
# `igris register-project` upsert the brain `projects` table); those verbs are
# unaffected by this rename and are covered by their own suites.

load _helpers.bash

@test "igris loadout --help exits 0 and names the verb" {
  run $CLI_BIN loadout --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "loadout" ]]
}

@test "igris loadout list exits 0 on an empty overlay" {
  stage_brain
  run $CLI_BIN loadout list
  [ "$status" -eq 0 ]
}

@test "igris registry is removed — unknown command, non-zero exit (no alias)" {
  run $CLI_BIN registry list
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unknown command" ]] || [[ "$output" =~ "registry" ]]
}
