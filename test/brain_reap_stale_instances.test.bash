#!/usr/bin/env bats

# brain_reap_stale_instances.test.bash — Tests for the BR-067 stale-instance
# reaper (brain-mcp-server/scripts/reap-stale-instances.ts).
#
# BR-067: brain-mcp-server stdio instances leaked — 62/65 were orphaned
# (ppid=1, parent dead) and survived up to 14 days. The reaper SIGTERMs only
# provably-orphaned instances (alive server, dead parent) and leaves a
# live-parent server untouched.
#
# These tests exercise the reaper end-to-end through the operator script with
# a sandboxed pidfile registry (IGRIS_PIDS_DIR) and real subprocesses, so the
# liveness probes are genuine.

load test_helper

setup() {
  REAP_SCRIPT="$IGRIS_ROOT/brain-mcp-server/scripts/reap-stale-instances.ts"
  TSX="$IGRIS_ROOT/brain-mcp-server/node_modules/.bin/tsx"

  [ -f "$REAP_SCRIPT" ] || skip "reap script missing at $REAP_SCRIPT"
  [ -x "$TSX" ] || skip "tsx not available at $TSX (run npm install in brain-mcp-server/)"

  # Sandboxed pidfile registry — never touch the real ~/.igris registry.
  export IGRIS_PIDS_DIR="$TEST_TEMP_DIR/reap_$BATS_TEST_NUMBER/pids"
  mkdir -p "$IGRIS_PIDS_DIR"

  SPAWNED_PIDS=()
}

teardown() {
  # Kill any subprocesses this test spawned.
  for pid in "${SPAWNED_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done
  [ -d "$TEST_TEMP_DIR" ] && rm -rf "$TEST_TEMP_DIR"
}

# Write a pidfile (keyed by parent PID) into the sandboxed registry.
# Usage: write_pidfile <server_pid> <parent_pid>
write_pidfile() {
  local server_pid="$1"
  local parent_pid="$2"
  printf '{"pid":%s,"ppid":%s,"started_at":"2026-05-19T00:00:00.000Z","db_path":"/tmp/x.db"}' \
    "$server_pid" "$parent_pid" > "$IGRIS_PIDS_DIR/${parent_pid}.json"
}

run_reaper() {
  run "$TSX" "$REAP_SCRIPT"
}

@test "reaper: SIGTERMs a provably-orphaned instance (alive server, dead parent)" {
  # Spawn a real subprocess to act as the orphaned "server".
  sleep 30 &
  local orphan_pid=$!
  SPAWNED_PIDS+=("$orphan_pid")

  # Register it with a dead parent (999999 is an unallocated PID).
  write_pidfile "$orphan_pid" 999999

  run_reaper
  assert_success
  [[ "$output" == *"SIGTERM'd 1 orphan"* ]]
  [[ "$output" == *"reaped PIDs: $orphan_pid"* ]]

  # The orphan must have exited.
  sleep 0.3
  ! kill -0 "$orphan_pid" 2>/dev/null

  # Its pidfile must have been pruned.
  [ ! -f "$IGRIS_PIDS_DIR/999999.json" ]
}

@test "reaper: leaves a live-parent instance UNTOUCHED (no false-positive reap)" {
  # The "server" subprocess.
  sleep 30 &
  local server_pid=$!
  SPAWNED_PIDS+=("$server_pid")

  # A live parent — use the bats process itself ($$), which is alive.
  write_pidfile "$server_pid" "$$"

  run_reaper
  assert_success
  [[ "$output" == *"SIGTERM'd 0 orphan"* ]]
  [[ "$output" == *"left 1 live instance(s) untouched"* ]]

  # The server must still be alive.
  kill -0 "$server_pid" 2>/dev/null

  # Its pidfile must still be present (a live instance is not pruned).
  [ -f "$IGRIS_PIDS_DIR/$$.json" ]
}

@test "reaper: prunes a stale pidfile whose server process is already dead" {
  # 999998 — a server PID that does not exist (already exited).
  write_pidfile 999998 999997

  run_reaper
  assert_success
  [[ "$output" == *"SIGTERM'd 0 orphan"* ]]
  [[ "$output" == *"pruned 1 stale pidfile"* ]]
  [ ! -f "$IGRIS_PIDS_DIR/999997.json" ]
}

@test "reaper: mixed registry — reaps orphan, keeps live, prunes dead" {
  sleep 30 &
  local orphan_pid=$!
  sleep 30 &
  local live_pid=$!
  SPAWNED_PIDS+=("$orphan_pid" "$live_pid")

  write_pidfile "$orphan_pid" 999999     # orphan: dead parent
  write_pidfile "$live_pid" "$$"         # live: parent alive
  write_pidfile 999998 999997            # stale: server dead

  run_reaper
  assert_success
  [[ "$output" == *"SIGTERM'd 1 orphan"* ]]
  [[ "$output" == *"left 1 live instance(s) untouched"* ]]

  sleep 0.3
  ! kill -0 "$orphan_pid" 2>/dev/null    # orphan reaped
  kill -0 "$live_pid" 2>/dev/null        # live untouched
}

@test "reaper: no-op on an empty registry" {
  run_reaper
  assert_success
  [[ "$output" == *"SIGTERM'd 0 orphan"* ]]
  [[ "$output" == *"pruned 0 stale pidfile"* ]]
}

@test "reaper: skips a malformed pidfile without failing the sweep" {
  echo 'not valid json {{{' > "$IGRIS_PIDS_DIR/12345.json"

  run_reaper
  # A malformed pidfile is skipped, not fatal — the sweep still succeeds.
  assert_success
  [[ "$output" == *"SIGTERM'd 0 orphan"* ]]
}
