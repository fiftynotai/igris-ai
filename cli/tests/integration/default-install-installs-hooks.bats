#!/usr/bin/env bats

# default-install-installs-hooks.bats — the v7-default canary, FR-212d-updated.
#
# TD-100 (the original): default install must not silently ship WITHOUT a
# working hooks pipeline. FR-212c moved per-project hooks to a GLOBAL projection
# at `igris init`. FR-212d Phase 2 then DELETED the per-project layer entirely
# (and the `--legacy-per-project` flag) — so the *default* (and only) `igris
# install` is register-only: no per-project settings.json. The hooks pipeline is
# now a single GLOBAL `~/.claude/settings.json` block written by `igris init`.
# This canary pins the register-only contract: install writes NO per-project
# settings.json, but DOES register the project (the de-no-op gate the global
# hooks key on).

load _helpers.bash

setup() {
  stage_brain
  export IGRIS_KEEP_BAK=0
}

@test "register-only default writes NO per-project settings.json (FR-212d)" {
  PROJ="$(stage_project regonly)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  # FR-212d: install is register-only — hooks project globally at `igris init`,
  # so no per-project settings.json (and no per-project .claude/ layer) is written.
  [ ! -f "$PROJ/.claude/settings.json" ]
  # But the registry row + features file ARE written (the de-no-op gate).
  [ -f "$IGRIS_BRAIN_DIR/projects/regonly/installed_features.json" ]
}

@test "install rejects the retired --legacy-per-project flag (FR-212d)" {
  PROJ="$(stage_project legacygone)"
  run $CLI_BIN install --legacy-per-project "$PROJ"
  # The flag was deleted — commander rejects the unknown option (non-zero exit).
  [ "$status" -ne 0 ]
}
