#!/bin/bash
set -euo pipefail

# Description: Pre-commit / CI wrapper around the TD-021 harness drift guard
#   (core/scripts/cli-adapters/check_harness_drift.sh). Runs the guard ONCE
#   against igris-ai's repo-root harness manifest, which (post-FR-136) declares
#   ONLY the agents that belong in this repo (the 7 Igris-core agents).
#
#   FR-136 removed the content-pipeline entries from the manifest and moved it
#   to the repo root, so the per-agent CORE_AGENTS loop (the FR-135 content-*
#   exclusion stopgap) is no longer needed - a single guard call against the
#   clean manifest is sufficient.
#
# Usage: validate_harness_drift.sh
#   No arguments. Resolves the repo root via git and invokes the guard with
#   --project-root pointed at it.
#
# Dependencies: bash, git, python3 (transitively via the guard + _common.sh).
# Exit codes:
#   0 - All checked targets MATCH, OR the only non-MATCH verdicts are MISSING
#       (the gated-codex stopgap — see STOPGAP block below).
#   1 - One or more targets DRIFTED (a harness EXISTS but its body diverged
#       from canonical). Real drift is always fatal.
#   0 - (clean skip) the guard or manifest is absent — see fail-open note below.
#
# =========================================================================
# STOPGAP: MISSING vs DRIFTED tolerance (FR-135 -> tightened by FR-138)
# -------------------------------------------------------------------------
# The guard (check_harness_drift.sh) is STRICT by contract: MISSING -> exit 1,
# DRIFTED -> exit 1. That contract is the source of truth and is left UNCHANGED.
# The stopgap tolerance lives HERE, at the pre-commit/CI entry point, because
# this is the layer that knows about the repo's transient state.
#
# Why MISSING must be tolerated RIGHT NOW (and only now):
#   The 7 Igris-core agents declare ONLY codex targets (.codex/agents/*.toml).
#   Codex emit is gated on Decision D1 and is NOT built in this repo yet, so
#   the guard reports every core-agent target MISSING. That is "not yet
#   compiled because the emitter is gated", NOT "you forgot to recompile after
#   an edit". Blocking every `core/agents/*.md` commit on a gated-inert target
#   would be a false positive.
#
# Discrimination rule applied below:
#   - DRIFTED present  -> FATAL (exit 1). A harness that EXISTS but diverged is
#                         real drift and must never be tolerated.
#   - only MISSING      -> NON-BLOCKING NOTICE (exit 0). Surfaced loudly so it
#                         is never silently forgotten.
#   - all MATCH         -> pass (exit 0).
#
# >>> FR-138 MUST flip MISSING back to FATAL <<<
#   FR-138 un-gates codex and compiles the .codex/agents/*.toml harnesses.
#   Once those exist, MISSING genuinely means "you forgot to recompile" and
#   must again be a hard failure. When implementing FR-138, DELETE the MISSING
#   tolerance below so this wrapper simply propagates the guard's strict exit
#   code (and ideally drop the per-agent loop too once FR-136 cleans the
#   manifest). Grep for "FR-138" in this file to find every spot to revert.
# =========================================================================
#
# Fail-open on a fresh clone WITHOUT the adapter layer:
#   If check_harness_drift.sh or the manifest is missing (e.g. a partial
#   checkout, or a project that never installed the cli-adapters), this wrapper
#   exits 0 with an explanatory message rather than hard-crashing the commit
#   hook. The guard's MISSING/DRIFTED verdict is only authoritative when the
#   guard itself is present to render it.

# ---------------------------------------------------------------------------
# Resolve the repo root. Prefer git; fall back to walking up from this script.
# ---------------------------------------------------------------------------
if REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

GUARD="$REPO_ROOT/core/scripts/cli-adapters/check_harness_drift.sh"
# FR-136: the project manifest lives at the repo root (not under core/).
MANIFEST="$REPO_ROOT/harness-manifest.json"

# ---------------------------------------------------------------------------
# Fail-open if the adapter layer is not present in this checkout.
# ---------------------------------------------------------------------------
if [ ! -f "$GUARD" ]; then
  echo "[harness-drift] guard not found: $GUARD"
  echo "[harness-drift] skipping drift check (adapter layer not installed)."
  exit 0
fi
if [ ! -f "$MANIFEST" ]; then
  echo "[harness-drift] manifest not found: $MANIFEST"
  echo "[harness-drift] skipping drift check (no harness manifest)."
  exit 0
fi

# ---------------------------------------------------------------------------
# Run the guard ONCE against the repo-root manifest (FR-136). The manifest now
# declares only the agents that belong in this repo, so no per-agent filtering
# is needed. We capture the self-evidencing report and parse the per-target
# verdict lines (the guard emits `[name/type] DRIFTED|MISSING|MATCH`) to
# discriminate fatal DRIFTED from tolerable MISSING (see STOPGAP block above).
# ---------------------------------------------------------------------------
drifted=0
missing=0
# set -e is intentionally relaxed for the call so a non-MATCH verdict does not
# abort before we classify it from the report.
report=""
if ! report="$(bash "$GUARD" --project-root "$REPO_ROOT" \
      --manifest "$MANIFEST" 2>&1)"; then
  : # non-zero exit is expected on MISSING/DRIFTED; classify via the report.
fi
# Echo the guard's self-evidencing report through so the surface stays
# auditable.
printf '%s\n' "$report"

# Count per-target verdicts. `grep -c` counts matching LINES; the guard prints
# exactly one `[name/type] VERDICT` line per target.
drifted="$(printf '%s\n' "$report" | grep -c 'DRIFTED' || true)"
missing="$(printf '%s\n' "$report" | grep -c 'MISSING' || true)"

# ---------------------------------------------------------------------------
# Verdict aggregation.
# ---------------------------------------------------------------------------
if [ "$drifted" -gt 0 ]; then
  # DRIFTED is always fatal — a harness exists but its body diverged.
  echo ""
  echo "[harness-drift] FATAL: $drifted core-agent harness(es) DRIFTED from canonical."
  echo "[harness-drift] A harness body diverged from its canonical prompt. Regenerate:"
  echo "[harness-drift]   bash core/scripts/cli-adapters/compile_harnesses.sh --project-root ."
  echo "[harness-drift]   (or 'igris harness compile' once it lands), then re-stage."
  exit 1
fi

if [ "$missing" -gt 0 ]; then
  # STOPGAP (FR-135 -> revert in FR-138): MISSING-only is non-blocking. The
  # codex targets are D1-gated and not yet compiled in this repo, so MISSING
  # here means "not built yet", not "you forgot to recompile".
  echo ""
  echo "[harness-drift] NOTICE: $missing core-agent codex harness(es) not yet compiled (codex emit gated until FR-138). Drift tolerance is a STOPGAP — FR-138 must flip MISSING back to fatal once codex is un-gated."
  exit 0
fi

exit 0
