#!/bin/bash
set -e

# Description: Validates that package-lock.json is consistent with the
#   workspace package.json files. Catches the drift class that bit on
#   2026-05-09 V7 push (TD-130 recovery, TD-134): a workspace package's
#   `name` field changed (e.g., `@igris-ai/cli` -> `igris-ai`) without
#   regenerating package-lock.json, causing `npm ci` to fail on the VPS
#   with "Missing: igris-ai@7.0.0 from lock file".
#
# Strategy: invoke `npm ci --dry-run --ignore-scripts` from repo root
#   (workspaces-aware). --dry-run does no install — just walks the
#   lockfile and resolves each entry against on-disk package.json files.
#   Drift surfaces as a non-zero exit with a "Missing: X@Y from lock file"
#   or "lock file's X@Y does not satisfy Y@Z" diagnostic.
#
# Usage: scripts/validate_lockfile_in_sync.sh
# Exit codes:
#   0 - lockfile is in sync with all workspace package.jsons
#   1 - drift detected (lockfile stale)
#   2 - tooling error (npm not on PATH, package.json missing, etc.)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm not on PATH" >&2
  exit 2
fi
if [ ! -f "package.json" ]; then
  echo "Error: package.json missing at repo root: $REPO_ROOT" >&2
  exit 2
fi
if [ ! -f "package-lock.json" ]; then
  echo "Error: package-lock.json missing at repo root: $REPO_ROOT" >&2
  exit 2
fi

# Run in a temp NPM_CONFIG_CACHE to avoid touching the user's npm cache.
# --ignore-scripts is critical — we never want lifecycle scripts firing
# during a pre-commit dry-run.
TMP_CACHE="$(mktemp -d)"
trap 'rm -rf "$TMP_CACHE"' EXIT

if output="$(NPM_CONFIG_CACHE="$TMP_CACHE" npm ci --dry-run --ignore-scripts 2>&1)"; then
  echo "OK: package-lock.json is in sync with workspace package.json files."
  exit 0
fi

# Non-zero from npm — surface the diagnostic verbatim, then exit 1.
echo "DRIFT: package-lock.json is out of sync." >&2
echo "" >&2
echo "$output" >&2
echo "" >&2
echo "Fix: run 'npm install --package-lock-only' from the repo root to" >&2
echo "  regenerate package-lock.json, then re-stage and re-commit." >&2
exit 1
