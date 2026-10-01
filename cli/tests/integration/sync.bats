#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../../../test/require_bats.bash" || exit 2
# sync.bats — integration tests for `igris sync` (M4 of MG-014).
#
# Hermetic via IGRIS_BRAIN_DIR. We DO NOT exercise real SSH/rsync paths
# (those need a real VPS); code-sync is covered by
# `cli/src/__tests__/sync-code.test.ts` (mocked child_process), by the
# BR-116 fake-ssh tier `cli/src/__tests__/sync-code-remote.test.ts`, AND by
# a manual-runbook entry in cli/README.md for the real sshd/pm2/nginx path.
#
# What this file DOES cover (per L-330: both producer (verb TS) AND
# consumer (CLI bridge in index.ts) must be exercised end-to-end via
# $CLI_BIN, not just unit-tested):
#
#   1. `igris sync status --dry-run`         — no network call, plan only
#   2. `igris sync data --dry-run` (empty)   — no network call, plan only
#   3. `igris sync all --dry-run`            — chains code+data plans
#   4. argument validation: unknown sub-verb returns exit 2
#   5. `igris sync code --dry-run --if-changed` — architect-added cron parity flag
#   6. BR-116: `sync code --dry-run` names the deploy workspace + pm2 probe;
#      `sync status --dry-run` names the read-only `node --version` probe
#
# Tests intentionally use `--dry-run` so no live SSH/HTTP happens; we are
# verifying the CLI bridge wiring, the dispatcher routing, and the
# dry-run plan emission — NOT the underlying ssh/rsync semantics.

load _helpers.bash

setup() {
  stage_brain
  # Seed a minimal config.json with both vps + remote_brain so the verbs
  # don't bail at the config-validation gate. The dry-run path doesn't
  # actually hit the network so 127.0.0.1 placeholders are fine.
  cat > "$IGRIS_BRAIN_DIR/config.json" <<'JSON'
{
  "remote_brain": {
    "url": "http://127.0.0.1:1",
    "api_key": "test-key"
  },
  "vps": {
    "host": "vps.example.com",
    "user": "deploy",
    "repo_path": "/srv/igris-test",
    "brain_path": "/srv/.igris-test"
  }
}
JSON
}

@test "sync status --dry-run: prints plan, no network call" {
  run $CLI_BIN sync status --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run plan:"* ]]
  [[ "$output" == *"/health"* ]]
  [[ "$output" == *"No filesystem writes were performed."* ]]
}

@test "sync data --dry-run with empty queue: prints plan, no network call" {
  # No sync_queue.jsonl seeded for any project — verb should still emit
  # a plan that includes the would-be MCP drain call.
  run $CLI_BIN sync data --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run plan:"* ]]
  [[ "$output" == *"igris_sync_queue_drain"* ]]
  [[ "$output" == *"No filesystem writes were performed."* ]]
}

@test "sync all --dry-run: chains code+data plans" {
  run $CLI_BIN sync all --dry-run
  [ "$status" -eq 0 ]
  # Code dry-run plan includes rsync + ssh + health probe.
  [[ "$output" == *"rsync"* ]]
  [[ "$output" == *"--delete"* ]]
  [[ "$output" == *"pm2 restart"* ]]
  # Data dry-run plan includes the MCP drain call.
  [[ "$output" == *"igris_sync_queue_drain"* ]]
}

@test "sync <unknown>: returns exit 2 with actionable error" {
  run $CLI_BIN sync bogus --dry-run
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown sub-verb"* ]] || [[ "$output" == *"Valid:"* ]]
}

@test "sync code --dry-run --if-changed: prints plan including git fetch + diff (cron parity, Risk #9)" {
  # The --if-changed flag enumerates `git fetch origin` and `git diff
  # --quiet HEAD` in the dry-run plan even though it would normally
  # short-circuit. This is the architect-derived addition to preserve
  # cron-style usage of the retired igris_vps_update.sh --if-changed.
  run $CLI_BIN sync code --dry-run --if-changed
  [ "$status" -eq 0 ]
  [[ "$output" == *"if-changed"* ]] || [[ "$output" == *"git"* ]]
  [[ "$output" == *"rsync"* ]]
  [[ "$output" == *"Dry-run plan:"* ]]
}

@test "sync data --dry-run when remote_brain unconfigured: exit 1" {
  # Remove remote_brain from config; sync data should bail at the gate.
  cat > "$IGRIS_BRAIN_DIR/config.json" <<'JSON'
{
  "vps": {
    "host": "h",
    "user": "u",
    "repo_path": "/r"
  }
}
JSON
  run $CLI_BIN sync data --dry-run
  [ "$status" -eq 1 ]
  [[ "$output" == *"remote_brain"* ]]
}

@test "sync code --dry-run: names the deploy workspace, the runner stages and the pm2 status probe (BR-116)" {
  run $CLI_BIN sync code --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *".igris-deploy"* ]] || return 1
  [[ "$output" == *"igris-deploy:preflight"* ]] || return 1
  [[ "$output" == *"npm ci"* ]] || return 1
  [[ "$output" == *'require("better-sqlite3")'* ]] || return 1
  [[ "$output" == *"pm2 restart igris-brain"* ]] || return 1
  [[ "$output" == *"pm2 jlist"* ]] || return 1
  [[ "$output" == *"/health"* ]] || return 1
}

@test "sync status --dry-run with a vps block: names the read-only node --version probe (BR-116)" {
  run $CLI_BIN sync status --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"node --version"* ]] || return 1
}

@test "sync push --dry-run: prints the plan and the /sync/push URL, never the key (TD-350)" {
  run $CLI_BIN sync push --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run plan:"* ]] || return 1
  [[ "$output" == *"http://127.0.0.1:1/sync/push"* ]] || return 1
  [[ "$output" == *"sync_state.last_push_at"* ]] || return 1
  [[ "$output" != *"test-key"* ]] || return 1
}
