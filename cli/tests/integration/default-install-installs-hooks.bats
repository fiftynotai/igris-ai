#!/usr/bin/env bats

# default-install-installs-hooks.bats — the v7-default canary.
#
# If this test ever fails, we have reintroduced TD-100 (default install ships
# without hooks). This test is the contract that the v6 silent-failure mode
# cannot return.

load _helpers.bash

setup() {
  stage_brain
  STUB_REPO="$BATS_TEST_TMPDIR/stub-repo"
  mkdir -p "$STUB_REPO/scripts"
  cat > "$STUB_REPO/scripts/igris_install.sh" <<'EOF'
#!/bin/bash
exit 0
EOF
  chmod +x "$STUB_REPO/scripts/igris_install.sh"
  cd "$STUB_REPO"
  export IGRIS_KEEP_BAK=0
}

@test "fresh install with no flags ships working hooks pipeline" {
  PROJ="$(stage_project canary)"
  $CLI_BIN install "$PROJ"
  # `python3 -c "...exit 0 if SessionEnd present else 1"` is the assertion.
  python3 -c "
import json, sys
with open('$PROJ/.claude/settings.json') as f:
    d = json.load(f)
cmd = d['hooks']['SessionEnd'][0]['hooks'][0]['command']
assert cmd == '\$HOME/.igris/core/hooks/shared/session_end.sh', f'unexpected command: {cmd}'
"
}
