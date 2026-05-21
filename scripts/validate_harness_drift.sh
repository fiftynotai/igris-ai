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
#   0 - All checked PROJECT-RELATIVE targets MATCH (home-path targets that are
#       MISSING are excluded from the gate — see SCOPING block below).
#   1 - One or more PROJECT-RELATIVE targets DRIFTED or MISSING. A drifted
#       harness (exists but body diverged) and a missing project-relative
#       harness (you forgot to compile) are both fatal.
#   0 - (clean skip) the guard or manifest is absent — see fail-open note below.
#
# =========================================================================
# SCOPING: MISSING is FATAL for project-relative targets (FR-138)
# -------------------------------------------------------------------------
# The guard (check_harness_drift.sh) is STRICT by contract: MISSING -> exit 1,
# DRIFTED -> exit 1. That contract is the source of truth and is UNCHANGED.
#
# FR-135 added a STOPGAP here that tolerated MISSING-only (exit 0) because the
# 7 core-agent codex targets were gated on Decision D1 and never compiled, so
# every one reported MISSING — a false positive, not "you forgot to recompile".
#
# FR-138 un-gated codex (Decision D1 RESOLVED — REIMPLEMENT) and now compiles
# the .codex/agents/*.toml harnesses. A MISSING project-relative target now
# genuinely means "you forgot to compile" and MUST be fatal again. So this
# wrapper flips MISSING -> FATAL — BUT only for PROJECT-RELATIVE targets.
#
# Why scope to project-relative:
#   The guard always checks BOTH surfaces (agents + skills) — it has no
#   --surface flag. The skills surface includes a HOME-PATH gemini target
#   (~/.gemini/commands, declared in surfaces-manifest.json). That target is
#   MISSING on any machine (incl. CI) that never projected gemini TOMLs.
#   Hard-failing the commit gate on a home-path skills target the developer
#   may legitimately not have projected would be a false positive everywhere.
#   The gate enforces what THIS repo commits-as-canonical: the project-relative
#   targets (.codex/agents/*.toml, AGENTS.md). Home/absolute-path targets are
#   out of the gate's scope and only surfaced as a NOTICE.
#
# Discrimination rule applied below (per target's RESOLVED path):
#   - DRIFTED (any path)            -> FATAL (exit 1). Existing-but-diverged is
#                                      real drift; never tolerated.
#   - MISSING, project-relative     -> FATAL (exit 1). You forgot to compile.
#   - MISSING, home/absolute path   -> NON-BLOCKING NOTICE (exit 0, out of scope).
#   - all in-scope targets MATCH    -> pass (exit 0).
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
# is needed. We capture the self-evidencing report and classify each per-target
# verdict (the guard emits `[name/type] DRIFTED|MISSING|MATCH`) by its resolved
# path: DRIFTED is always fatal; MISSING is fatal ONLY for project-relative
# targets (home/absolute-path targets are out of the gate's scope — see the
# SCOPING block above). The guard has no --surface flag, so the project-relative
# classification is done HERE, from the resolved paths in the report.
# ---------------------------------------------------------------------------
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

# Classify verdicts via python3 (python3 is a guaranteed dependency). For each
# `[name/type] VERDICT` block we resolve the target's on-disk path from the
# block's path line (harness/artifact/artifact dir) and decide scope:
#   - DRIFTED               -> always fatal.
#   - MISSING, path under REPO_ROOT -> fatal (you forgot to compile).
#   - MISSING, home/absolute path   -> out-of-scope NOTICE (not fatal).
# The script prints three integers: <fatal_drifted> <fatal_missing> <oos_missing>
# The classifier is written to a temp script and run as `python3 <file>` so the
# heredoc (which contains parens and apostrophes) is NOT nested inside a `$(...)`
# command substitution — bash's command-substitution tokenizer mis-parses such
# nesting (SC2259-adjacent), causing "unexpected EOF". The report is passed via
# an env var to avoid stdin/heredoc collisions.
CLASSIFIER="$(mktemp "${TMPDIR:-/tmp}/igris_drift_classify.XXXXXX.py")"
trap 'rm -f "$CLASSIFIER"' EXIT
cat > "$CLASSIFIER" <<'PY'
import os
import re
import sys

repo_root = os.path.realpath(sys.argv[1])
report = os.environ.get("IGRIS_DRIFT_REPORT", "").splitlines()

verdict_re = re.compile(
    r"^\s*\[(?P<name>[^\]]+)\]\s+(?P<verdict>MATCH|DRIFTED|MISSING)\b"
    r"(?:\s+\S+\s+(?P<rest>.*))?$"
)
pathline_re = re.compile(
    r"^\s*(?P<label>harness|artifact dir|artifact)\s*:\s*(?P<path>\S.*)$"
)


def is_project_relative(path):
    """True if the resolved path lives under the repo root."""
    if not path:
        return False
    rp = os.path.realpath(path)
    try:
        return os.path.commonpath([rp, repo_root]) == repo_root
    except ValueError:
        return False


def strip_paren(text):
    return re.sub(r"\s*\(.*\)\s*$", "", text).strip()


def extract_inline_path(rest):
    # Some MISSING reasons inline the path after a colon, e.g.
    # "canonical file absent: /abs/path".
    if rest and ":" in rest:
        cand = strip_paren(rest.rsplit(":", 1)[1].strip())
        if cand.startswith(("/", "~")):
            return os.path.expanduser(cand)
    return ""


fatal_drifted = 0
fatal_missing = 0
oos_missing = 0

i = 0
n = len(report)
while i < n:
    m = verdict_re.match(report[i])
    if not m:
        i += 1
        continue
    verdict = m.group("verdict")
    rest = m.group("rest") or ""
    # Resolve this block's path: prefer an inline path in the verdict line,
    # else scan following indented path lines until the next verdict block.
    path = extract_inline_path(rest)
    j = i + 1
    while j < n and not verdict_re.match(report[j]):
        pm = pathline_re.match(report[j])
        if pm and not path:
            path = os.path.expanduser(strip_paren(pm.group("path").strip()))
        j += 1

    if verdict == "DRIFTED":
        fatal_drifted += 1
    elif verdict == "MISSING":
        if is_project_relative(path):
            fatal_missing += 1
        else:
            oos_missing += 1
    i = j

print(f"{fatal_drifted} {fatal_missing} {oos_missing}")
PY

classification="$(IGRIS_DRIFT_REPORT="$report" python3 "$CLASSIFIER" "$REPO_ROOT")"
rm -f "$CLASSIFIER"
trap - EXIT
read -r fatal_drifted fatal_missing oos_missing <<< "$classification"

# ---------------------------------------------------------------------------
# Verdict aggregation.
# ---------------------------------------------------------------------------
if [ "$oos_missing" -gt 0 ]; then
  # Home/absolute-path targets (e.g. the gemini skills ~/.gemini/commands
  # surface) that are MISSING are out of the gate's scope — surface as a NOTICE
  # so they are never silently forgotten, but do NOT block the commit.
  echo ""
  echo "[harness-drift] NOTICE: $oos_missing out-of-scope (home/absolute-path) harness target(s) MISSING — not projected on this machine. These are excluded from the commit gate (e.g. the gemini ~/.gemini/commands skills surface)."
fi

if [ "$fatal_drifted" -gt 0 ]; then
  # DRIFTED is always fatal — a harness exists but its body diverged.
  echo ""
  echo "[harness-drift] FATAL: $fatal_drifted harness(es) DRIFTED from canonical."
  echo "[harness-drift] A harness body diverged from its canonical prompt. Regenerate:"
  echo "[harness-drift]   igris harness compile --project-root ."
  echo "[harness-drift]   (or bash core/scripts/cli-adapters/compile_harnesses.sh --project-root .), then re-stage."
  exit 1
fi

if [ "$fatal_missing" -gt 0 ]; then
  # FR-138: MISSING for a project-relative target is fatal again — codex is
  # un-gated, so a missing .codex/agents/*.toml means you forgot to compile.
  echo ""
  echo "[harness-drift] FATAL: $fatal_missing project-relative harness(es) MISSING — you forgot to compile. Regenerate:"
  echo "[harness-drift]   igris harness compile --project-root ."
  echo "[harness-drift]   (or bash core/scripts/cli-adapters/compile_harnesses.sh --project-root .), then re-stage."
  exit 1
fi

exit 0
