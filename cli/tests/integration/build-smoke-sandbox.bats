#!/usr/bin/env bats

# build-smoke-sandbox.bats — TD-426 twin of cli/scripts/smoke-bundled-mcp.sh,
# the guard `cd cli && npm run build` (copy-templates.sh) and npm-publish.yml
# run against the vendored brain bundle.
#
# What is proved:
#   (G)  the REAL bundle, spawned under a fake HOME whose ~/.igris/memory/
#        knowledge.db is a DECOY (one table, `decoy_sentinel`), opens a DB under
#        the guard's mktemp sandbox, prints it, and leaves the decoy byte-for-
#        byte untouched — no `engine_migrations`, no pidfile dir under the fake
#        HOME. This is the brief's AC-2 assertion. Red-first (2026-08-27, HEAD
#        812ae57's bundle): exit 1, `printed no '[brain] db:' line`, and the
#        decoy had grown a full schema.
#   (R1) a stub that prints the fake-HOME path -> `outside sandbox`
#   (R2) a stub that prints nothing            -> `printed no '[brain] db:' line`
#   (R3) a stub that fails module resolution   -> `module resolution error`
#        (BR-068's original assertion, preserved — the brief's R2)
#   (R4) a stub that prints the sandbox path but creates no file -> `sandbox DB
#        missing` (the -s check is independent of what the child printed)
#   (C)  a stub that prints the sandbox path AND creates the file -> exit 0
#        (the guard is not always-fail)
#   (E)  no entry / missing entry -> exit 2
#
# Stubs are `.mjs` heredocs so node reports `ERR_MODULE_NOT_FOUND` / "Cannot
# find package" for (R3) — a CJS stub would say "Cannot find module", which the
# guard's grep does not (and should not) match.
#
# The guard owns its sandbox, so this file loads _helpers.bash for CLI_DIST only
# and does NOT call stage_brain. Every [[ ]] carries `|| return 1` (TD-341).

load _helpers.bash

setup() {
  CLI_ROOT="$(cd "$CLI_DIST/.." && pwd)"
  SMOKE="$CLI_ROOT/scripts/smoke-bundled-mcp.sh"
  ENTRY="$CLI_DIST/brain-mcp-server/dist/index.js"
  [ -f "$SMOKE" ] || skip "guard script missing at $SMOKE"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"

  # A sandbox must not inherit an ambient seam from the operator's shell.
  unset IGRIS_BRAIN_DIR IGRIS_DB_PATH IGRIS_PIDS_DIR

  FAKE_HOME="$BATS_TEST_TMPDIR/home"
  DECOY="$FAKE_HOME/.igris/memory/knowledge.db"
  mkdir -p "$FAKE_HOME/.igris/memory"
  sqlite3 "$DECOY" "CREATE TABLE decoy_sentinel(x);"
  DECOY_SIZE_BEFORE="$(wc -c < "$DECOY" | tr -d ' ')"

  STUBS="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUBS"
}

decoy_table_count() {
  sqlite3 "$DECOY" "SELECT count(*) FROM sqlite_master;"
}

decoy_has_engine_migrations() {
  sqlite3 "$DECOY" "SELECT count(*) FROM sqlite_master WHERE name='engine_migrations';"
}

@test "(G) real bundle: opens a DB under the mktemp sandbox, prints it, decoy under fake HOME untouched" {
  [ -f "$ENTRY" ] || skip "bundle not staged — cd cli && npm run build"

  HOME="$FAKE_HOME" run bash "$SMOKE" "$ENTRY"
  echo "$output"
  [ "$status" -eq 0 ]

  # The printed path is the guard's own sandbox, not the fake HOME.
  opened="$(printf '%s\n' "$output" | sed -n 's/^smoke: bundled MCP opened \(.*\) (sandboxed)$/\1/p')"
  [ -n "$opened" ]
  [[ "$opened" == *"igris-mcp-smoke."*"/memory/knowledge.db" ]] || return 1
  [[ "$opened" != "$FAKE_HOME/.igris"* ]] || return 1

  # The decoy is exactly what setup() made: one table, no engine_migrations,
  # same size. A live-brain escape would have migrated it.
  [ "$(decoy_table_count)" -eq 1 ]
  [ "$(decoy_has_engine_migrations)" -eq 0 ]
  [ "$(wc -c < "$DECOY" | tr -d ' ')" -eq "$DECOY_SIZE_BEFORE" ]

  # pidsDir() mirrors the middle tier: no registry under the fake HOME.
  [ ! -e "$FAKE_HOME/.igris/brain-mcp-server.pids" ]
}

@test "(R1) stub prints the fake-HOME path -> exit 1, 'outside sandbox'" {
  cat > "$STUBS/escape.mjs" <<'EOF'
process.stderr.write('[brain] db: ' + process.env.HOME + '/.igris/memory/knowledge.db\n');
setInterval(() => {}, 1000);
EOF
  HOME="$FAKE_HOME" run bash "$SMOKE" "$STUBS/escape.mjs" 1
  echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"outside sandbox"* ]] || return 1
}

@test "(R2) stub prints nothing -> exit 1, \"printed no '[brain] db:' line\"" {
  cat > "$STUBS/silent.mjs" <<'EOF'
setInterval(() => {}, 1000);
EOF
  HOME="$FAKE_HOME" run bash "$SMOKE" "$STUBS/silent.mjs" 1
  echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"printed no '[brain] db:' line"* ]] || return 1
}

@test "(R3) stub fails module resolution -> exit 1, 'module resolution error' (BR-068 preserved)" {
  cat > "$STUBS/broken.mjs" <<'EOF'
import 'nonexistent-pkg-td426';
EOF
  HOME="$FAKE_HOME" run bash "$SMOKE" "$STUBS/broken.mjs" 1
  echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"module resolution error"* ]] || return 1
  [[ "$output" == *"ERR_MODULE_NOT_FOUND"* ]] || return 1
}

@test "(R4) stub prints the sandbox path but creates no file -> exit 1, 'sandbox DB missing'" {
  cat > "$STUBS/liar.mjs" <<'EOF'
process.stderr.write('[brain] db: ' + process.env.IGRIS_DB_PATH + '\n');
setInterval(() => {}, 1000);
EOF
  HOME="$FAKE_HOME" run bash "$SMOKE" "$STUBS/liar.mjs" 1
  echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"sandbox DB missing"* ]] || return 1
}

@test "(C) stub prints the sandbox path AND creates the file -> exit 0 (the guard is not always-fail)" {
  cat > "$STUBS/honest.mjs" <<'EOF'
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.IGRIS_DB_PATH, 'not-empty');
process.stderr.write('[brain] db: ' + process.env.IGRIS_DB_PATH + '\n');
setInterval(() => {}, 1000);
EOF
  HOME="$FAKE_HOME" run bash "$SMOKE" "$STUBS/honest.mjs" 1
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"smoke: bundled MCP opened "*"igris-mcp-smoke."*"/memory/knowledge.db (sandboxed)"* ]] || return 1
  [ "$(decoy_table_count)" -eq 1 ]
}

@test "(E) no entry argument -> exit 2 with usage" {
  run bash "$SMOKE"
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage: smoke-bundled-mcp.sh"* ]] || return 1
}

@test "(E2) missing entry file -> exit 2" {
  run bash "$SMOKE" "$STUBS/does-not-exist.mjs"
  [ "$status" -eq 2 ]
}
