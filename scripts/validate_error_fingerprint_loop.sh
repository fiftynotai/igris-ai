#!/bin/bash
set -u

# validate_error_fingerprint_loop.sh
#
# TD-240 regression net: the "never debug twice" claim depends on mender looking
# up known errors before diagnosis and /hunt storing only verified recoveries.
#
# Usage:
#   scripts/validate_error_fingerprint_loop.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MENDER="$REPO_ROOT/core/agents/mender.md"
HUNT="$REPO_ROOT/core/skills/hunt/SKILL.md"

failed=0

require() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  local normalized

  normalized="$(tr '\n' ' ' < "$file" | tr -s '[:space:]' ' ')"

  if ! printf '%s\n' "$normalized" | grep -Eq "$pattern"; then
    echo "[error-loop] MISSING: $description"
    echo "[error-loop]   file: ${file#$REPO_ROOT/}"
    echo "[error-loop]   pattern: $pattern"
    failed=1
  fi
}

require "$MENDER" 'first diagnostic action is an[[:space:]]+`igris_error_lookup` call' \
  "mender must declare lookup as the first diagnostic action"
require "$MENDER" 'Do not parse,[[:space:]]+grep,[[:space:]]+hypothesize,[[:space:]]+or inspect files until that lookup completes' \
  "mender must not diagnose before lookup"
require "$MENDER" 'Storage is verification-owned: do not store a new solution for a hypothesis' \
  "mender must avoid storing unverified hypotheses"
require "$MENDER" '## Error Memory Handoff' \
  "mender output must include an Error Memory Handoff block"
require "$MENDER" 'Canonical Error Message' \
  "mender must return the canonical message used for lookup"
require "$MENDER" 'Proposed Solution' \
  "mender must return the solution candidate for post-pass storage"

require "$HUNT" 'mcp__igris-brain__igris_error_lookup' \
  "/hunt must allow the error lookup/store tool"
require "$HUNT" 'If this PASS follows a mender-guided retry and mender returned an Error[[:space:]]+Memory Handoff' \
  "/hunt must store verified recoveries after a passing retry"
require "$HUNT" 'This storage step is orchestrator-owned because only the orchestrator sees[[:space:]]+the post-fix sentinel PASS' \
  "/hunt must own storage only after sentinel PASS"
require "$HUNT" 'first diagnostic action MUST be[[:space:]]+`igris_error_lookup`' \
  "/hunt must instruct mender to lookup before diagnosis"
require "$HUNT" 'Canonical Error Message.*Root[[:space:]]+Cause.*Proposed Solution' \
  "/hunt must require the full mender handoff fields"

if [ "$failed" -eq 0 ]; then
  echo "[error-loop] PASS"
fi

exit "$failed"
