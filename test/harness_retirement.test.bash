#!/usr/bin/env bats

# harness_retirement.test.bash - FR-152 retirement test for sync_claude_agents.sh.
#
# FR-152 retires the legacy `sync_claude_agents.sh` body-refresh adapter (the
# script that powered FR-149's Case C real-file claude back-compat path). Post-
# FR-152, claude + gemini agent targets are atomic symlinks that resolve to a
# single registry-resident harness.md, assembled at compile/vendor time. No
# script-shaped consumer of the deleted file should remain anywhere in the
# repo. This test pins that retirement:
#
#   1. The script file is absent from the repo's core/scripts/cli-adapters/.
#   2. The runtime mirror at ~/.igris/core/scripts/cli-adapters/ is also absent.
#   3. No remaining `sync_claude_agents` references exist under core/, cli/,
#      scripts/, docs/, or test/ (with .git/ + node_modules/ + agent-memory/
#      + this test file itself excluded).
#
# See L-519 (the symlink IS the projection — no body-refresh chain remains).

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  RUNTIME_BRAIN="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
  RUNTIME_ADAPTERS="$RUNTIME_BRAIN/core/scripts/cli-adapters"
}

@test "FR-152: sync_claude_agents.sh is DELETED from the repo" {
  [ ! -f "$ADAPTERS/sync_claude_agents.sh" ]
}

@test "FR-152: sync_claude_agents.sh is DELETED from the runtime mirror" {
  # FR-152: the runtime mirror is the destination of the TD-096 copy step; the
  # plan's deletion verification is a `! -f` check (no `verify_mirror.sh` for
  # absence — that primitive checks file equality). Skipped only when the
  # runtime brain isn't installed on this machine (a fresh CI box).
  if [ ! -d "$RUNTIME_BRAIN/core" ]; then
    skip "runtime brain not installed at $RUNTIME_BRAIN"
  fi
  [ ! -f "$RUNTIME_ADAPTERS/sync_claude_agents.sh" ]
}

@test "FR-152: no remaining sync_claude_agents references in core/cli/scripts/docs/test" {
  # FR-152: a hidden caller would leave compile silently broken for the claude
  # agent target. This is the load-bearing retirement guard the brief requires:
  # zero matches across the load-bearing source paths. The grep excludes
  #   - .git/ and node_modules/ (obvious),
  #   - agent-memory/ (historical citations, not callers),
  #   - this test file itself (the strings ARE the test).
  run grep -rn 'sync_claude_agents' \
       "$IGRIS_ROOT/core" \
       "$IGRIS_ROOT/cli" \
       "$IGRIS_ROOT/scripts" \
       "$IGRIS_ROOT/docs" \
       "$IGRIS_ROOT/test" \
       --exclude-dir=node_modules \
       --exclude-dir=.git \
       --exclude-dir=agent-memory \
       --exclude=harness_retirement.test.bash
  # `grep` returns 1 (no matches) on success. Treat 0 (hits) and 2 (error) as
  # failures so the test fails loudly when a stray reference appears.
  [ "$status" -eq 1 ]
}
