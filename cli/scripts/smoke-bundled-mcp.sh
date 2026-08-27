#!/usr/bin/env bash
# smoke-bundled-mcp.sh — spawn the vendored brain MCP bundle in a throwaway
# sandbox and prove two things (TD-426, extracted from copy-templates.sh):
#
#   1. BR-068: it boots without a module-resolution error (ERR_MODULE_NOT_FOUND /
#      "Cannot find package" in stderr fails).
#   2. TD-426: it opened its SQLite DB INSIDE the sandbox — never the operator's
#      live ~/.igris/memory/knowledge.db. Before TD-426 the stdio entrypoint
#      booted from a static DB_PATH constant, so this "sandboxed" spawn opened
#      and MIGRATED the live brain on every `cd cli && npm run build`
#      (instances v3 on 2026-08-26, v4 on 2026-08-27).
#
# The child PRINTS the DB it opened (`[brain] db: <path>` on stderr, emitted by
# getEngine() before bootEngine). This script hard-fails unless that line is
# present AND names a path under the sandbox AND the sandbox DB file exists
# non-empty after the boot (an independent check — a child that lies about its
# path still has to have created the file).
#
# Both seams are set on purpose (belt and braces): IGRIS_BRAIN_DIR is the ONE
# seam a sandbox must set (tier 3 of db.ts#resolveDbPath); IGRIS_DB_PATH
# (tier 2) names the same file so the fence holds even if one tier regresses.
# The tiers themselves are held by brain-mcp-server/src/__tests__/
# db-path-resolution.test.ts and the IGRIS_BRAIN_DIR-only spawn in
# cli/src/__tests__/tarball.test.ts.
#
# Callers: cli/scripts/copy-templates.sh (every `npm run build`) and
# .github/workflows/npm-publish.yml. Twin: cli/tests/integration/
# build-smoke-sandbox.bats. Not packed (cli/package.json `files`).
#
# usage: smoke-bundled-mcp.sh <entry.js> [max-wait-seconds]   (default: 10)
#
# bash 3.2 (macOS /bin/bash): no ${var,,}, arrays, mapfile, eval, GNU timeout.
set -euo pipefail

entry="${1:-}"
wait_s="${2:-10}"

if [ -z "$entry" ] || [ ! -f "$entry" ]; then
  echo "usage: smoke-bundled-mcp.sh <entry.js> [max-wait-seconds]" >&2
  echo "smoke: entry not found: '${entry}'" >&2
  exit 2
fi

# macOS exports TMPDIR with a trailing slash; strip it so the printed path has
# no `//` (cosmetic — the containment check compares the same string).
tmp_root="${TMPDIR:-/tmp}"
tmp_root="${tmp_root%/}"
sandbox="$(mktemp -d "$tmp_root/igris-mcp-smoke.XXXXXX")"
stderr_file="$(mktemp "$tmp_root/igris-mcp-smoke-err.XXXXXX")"
cleanup() { rm -rf "$sandbox" "$stderr_file"; }
trap cleanup EXIT

# better-sqlite3 creates the DB FILE but never its parent directory — without
# memory/ pre-created a sandbox-honouring server crashes at boot, and a crash
# would otherwise read as "server exited cleanly".
mkdir -p "$sandbox/memory"
sandbox_db="$sandbox/memory/knowledge.db"

IGRIS_BRAIN_DIR="$sandbox" IGRIS_DB_PATH="$sandbox_db" \
  node "$entry" >/dev/null 2>"$stderr_file" &
pid=$!

# Wait for boot EVIDENCE, not a fixed interval: the child exiting on its own
# (stdin EOF -> the BR-067 teardown, the usual build-time path) or the stdio
# "started" banner (the child idles when stdin is a TTY). Polled every 0.25 s
# up to wait_s seconds. A fixed 2 s sleep read one healthy boot as "sandbox DB
# missing" under load (2026-08-27) — which would have failed the build.
deadline=$(( $(date +%s) + wait_s ))
while kill -0 "$pid" 2>/dev/null; do
  if grep -q 'MCP Server .* started (stdio)' "$stderr_file"; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
  sleep 0.25
done

# The brain MCP is a stdio server that idles until killed: still alive here
# means it booted (or hit the ceiling); a clean early exit is also accepted —
# the checks below decide whether it did what it claimed.
alive=0
if kill -0 "$pid" 2>/dev/null; then
  alive=1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
else
  wait "$pid" 2>/dev/null || true
fi

fail() {
  echo "smoke: bundled MCP smoke test FAILED — $1" >&2
  echo "smoke: captured stderr follows" >&2
  cat "$stderr_file" >&2
  exit 1
}

if grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find package' "$stderr_file"; then
  fail "module resolution error"
fi

opened="$(grep -m1 '^\[brain\] db: ' "$stderr_file" | sed 's/^\[brain\] db: //')" || true
if [ -z "$opened" ]; then
  fail "bundle printed no '[brain] db:' line (a pre-TD-426 bundle, or the boot line moved)"
fi

case "$opened" in
  "$sandbox"/*) ;;
  *) fail "bundle opened '$opened' — outside sandbox '$sandbox' (live-brain escape)" ;;
esac

if [ ! -s "$sandbox_db" ]; then
  fail "sandbox DB missing or empty at '$sandbox_db' (server escaped the sandbox or crashed before opening its DB)"
fi

echo "smoke: bundled MCP opened $opened (sandboxed)"
if [ "$alive" -eq 1 ]; then
  echo "smoke: bundled MCP smoke test passed (server booted and idled)"
else
  echo "smoke: bundled MCP smoke test passed (server exited cleanly)"
fi
