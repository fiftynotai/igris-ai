#!/usr/bin/env bats

# default-install-installs-hooks.bats — the v7-default canary, FR-212c-updated.
#
# TD-100 (the original): default install must not silently ship WITHOUT a
# working hooks pipeline. FR-212c moved per-project hooks to a GLOBAL projection
# at `igris init` — so the *default* `igris install` is register-only (no
# per-project settings.json), and the per-project hooks pipeline is reachable
# via `--legacy-per-project`. This canary now pins BOTH halves:
#   1. `--legacy-per-project` still materializes a working hooks pipeline (the
#      TD-100 regression cannot return for the legacy path).
#   2. the register-only default writes NO per-project settings.json (the
#      FR-212c contract — global projection owns hooks).

load _helpers.bash

setup() {
  stage_brain
  export IGRIS_KEEP_BAK=0
}

@test "legacy-per-project install ships working hooks pipeline (TD-100 regression)" {
  PROJ="$(stage_project canary)"
  $CLI_BIN install --legacy-per-project "$PROJ"
  # `python3 -c "...exit 0 if SessionEnd present else 1"` is the assertion.
  python3 -c "
import json, sys
with open('$PROJ/.claude/settings.json') as f:
    d = json.load(f)
cmd = d['hooks']['SessionEnd'][0]['hooks'][0]['command']
assert cmd == '\$HOME/.igris/core/hooks/shared/session_end.sh', f'unexpected command: {cmd}'
"
}

@test "register-only default writes NO per-project settings.json (FR-212c)" {
  PROJ="$(stage_project regonly)"
  run $CLI_BIN install "$PROJ"
  [ "$status" -eq 0 ]
  # The default install is register-only: hooks project globally at `igris init`,
  # so no per-project settings.json is written here.
  [ ! -f "$PROJ/.claude/settings.json" ]
  # But the registry row + features file ARE written (the de-no-op gate).
  [ -f "$IGRIS_BRAIN_DIR/projects/regonly/installed_features.json" ]
}
