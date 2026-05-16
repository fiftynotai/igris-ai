#!/bin/bash

# Description: Orchestrate harness regeneration. Reads harness-manifest.json
#              and, for each agent/target, invokes the matching per-target
#              sync adapter (sync_claude_agents.sh / sync_codex_agents.sh) to
#              regenerate the harness file from its canonical prompt (TD-021).
# Usage: compile_harnesses.sh --project-root <dir> [options]
#   --project-root <dir>   - REQUIRED. Root that canonical/target paths in the
#                            manifest resolve against.
#   --manifest <path>      - Manifest file. Default: harness-manifest.json
#                            next to this script.
#   --filter <name-glob>   - Only process agents whose name matches the glob
#                            (shell case-glob, e.g. 'content-*'). Default: all.
#   --target claude|codex|all - Restrict to one target type. Default: all.
# Dependencies: python3, _common.sh + sync_*.sh (auto-located from script dir)
# Exit codes:
#   0 - All selected agent/target syncs succeeded (or were cleanly skipped)
#   1 - One or more syncs failed
#   2 - Usage error (bad/missing arguments)
#
# CODEX TARGETS & DECISION D1:
#   sync_codex_agents.sh is gated on Decision D1 (BLOCKED — see that script).
#   When `--target` selects codex (or `all`), codex syncs will fail unless the
#   environment has IGRIS_CODEX_D1=reimplement set. compile_harnesses.sh
#   reports each failure but does not itself resolve D1.

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the adapter directory and shared helpers.
# ---------------------------------------------------------------------------
ADAPTER_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=_common.sh
source "$ADAPTER_DIR/_common.sh"

readonly DEFAULT_MANIFEST="$ADAPTER_DIR/harness-manifest.json"

# ---------------------------------------------------------------------------
# usage — prints usage and exits with code 2.
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 --project-root <dir> [--manifest <path>]" >&2
  echo "                          [--filter <name-glob>] [--target claude|codex|all]" >&2
  echo "" >&2
  echo "Regenerates harness files declared in the manifest from canonical prompts." >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
PROJECT_ROOT=""
MANIFEST="$DEFAULT_MANIFEST"
FILTER='*'
TARGET_KIND="all"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-root)
      PROJECT_ROOT="${2:-}"
      shift 2 || usage
      ;;
    --manifest)
      MANIFEST="${2:-}"
      shift 2 || usage
      ;;
    --filter)
      FILTER="${2:-}"
      shift 2 || usage
      ;;
    --target)
      TARGET_KIND="${2:-}"
      shift 2 || usage
      ;;
    --help|-h)
      usage
      ;;
    *)
      echo "Error: unknown argument '$1'" >&2
      usage
      ;;
  esac
done

if [ -z "$PROJECT_ROOT" ]; then
  echo "Error: --project-root is required" >&2
  usage
fi
if [ ! -d "$PROJECT_ROOT" ]; then
  echo "Error: project root '$PROJECT_ROOT' is not a directory" >&2
  exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "Error: manifest '$MANIFEST' does not exist" >&2
  exit 1
fi
case "$TARGET_KIND" in
  claude|codex|all) : ;;
  *)
    echo "Error: --target must be claude, codex, or all (got '$TARGET_KIND')" >&2
    usage
    ;;
esac

# Resolve project root to an absolute path.
PROJECT_ROOT="$( cd "$PROJECT_ROOT" && pwd )"

# ---------------------------------------------------------------------------
# Flatten the manifest into tab-separated work rows via python3:
#   name <TAB> versioned <TAB> canon-dir <TAB> canon-glob-or-file <TAB>
#   body-exception-or-empty <TAB> target-type <TAB> target-path
# One row per agent/target. python3 (no jq) per the _common.sh convention.
# ---------------------------------------------------------------------------
WORK_ROWS=$(python3 - "$MANIFEST" "$FILTER" "$TARGET_KIND" <<'PY'
import fnmatch
import json
import sys

manifest_path = sys.argv[1]
name_filter = sys.argv[2]
target_kind = sys.argv[3]

with open(manifest_path, "r", encoding="utf-8") as fh:
    manifest = json.load(fh)

for agent in manifest.get("agents", []):
    name = agent["name"]
    if not fnmatch.fnmatch(name, name_filter):
        continue
    canon = agent["canonical"]
    versioned = "1" if canon.get("versioned") else "0"
    canon_dir = canon["dir"]
    # versioned -> glob; unversioned -> literal file.
    canon_ref = canon.get("glob", "") if canon.get("versioned") else canon.get("file", "")
    # `-` is the empty-field sentinel: bash `read` with a tab IFS collapses
    # adjacent tabs (tab is whitespace), so an empty column would shift all
    # later columns. A literal `-` keeps every column positionally stable.
    body_exc = agent.get("body_exception", "") or "-"
    for target in agent.get("targets", []):
        ttype = target["type"]
        if target_kind != "all" and ttype != target_kind:
            continue
        row = "\t".join([
            name, versioned, canon_dir, canon_ref, body_exc,
            ttype, target["path"],
        ])
        print(row)
PY
)

if [ -z "$WORK_ROWS" ]; then
  echo "No agent/target rows matched (filter='$FILTER', target='$TARGET_KIND')." >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Process each work row.
# ---------------------------------------------------------------------------
TOTAL=0
OK=0
FAIL=0
SUMMARY=()

while IFS=$'\t' read -r name versioned canon_dir canon_ref body_exc ttype target_path; do
  [ -z "$name" ] && continue
  TOTAL=$((TOTAL + 1))

  # Resolve the canonical source path.
  canon_abs=""
  if [ "$versioned" = "1" ]; then
    if ! canon_abs=$(latest_canonical "$PROJECT_ROOT/$canon_dir" "$canon_ref"); then
      SUMMARY+=("FAIL  $name/$ttype — no canonical match for '$canon_ref' in $canon_dir")
      FAIL=$((FAIL + 1))
      continue
    fi
  else
    canon_abs="$PROJECT_ROOT/$canon_dir/$canon_ref"
    if [ ! -f "$canon_abs" ]; then
      SUMMARY+=("FAIL  $name/$ttype — canonical file missing: $canon_abs")
      FAIL=$((FAIL + 1))
      continue
    fi
  fi

  target_abs="$PROJECT_ROOT/$target_path"

  # Resolve an optional body-exception sidecar. `-` is the empty sentinel.
  exc_abs=""
  if [ -n "$body_exc" ] && [ "$body_exc" != "-" ]; then
    exc_abs="$ADAPTER_DIR/body-exceptions/$body_exc.json"
    if [ ! -f "$exc_abs" ]; then
      SUMMARY+=("FAIL  $name/$ttype — body-exception sidecar missing: $exc_abs")
      FAIL=$((FAIL + 1))
      continue
    fi
  fi

  # Dispatch to the matching per-target adapter.
  rc=0
  case "$ttype" in
    claude)
      if [ -n "$exc_abs" ]; then
        bash "$ADAPTER_DIR/sync_claude_agents.sh" "$canon_abs" "$target_abs" "$exc_abs" || rc=$?
      else
        bash "$ADAPTER_DIR/sync_claude_agents.sh" "$canon_abs" "$target_abs" || rc=$?
      fi
      ;;
    codex)
      bash "$ADAPTER_DIR/sync_codex_agents.sh" "$canon_abs" "$target_abs" "$name" || rc=$?
      ;;
    *)
      SUMMARY+=("FAIL  $name/$ttype — unknown target type")
      FAIL=$((FAIL + 1))
      continue
      ;;
  esac

  if [ "$rc" -eq 0 ]; then
    SUMMARY+=("OK    $name/$ttype -> $target_path")
    OK=$((OK + 1))
  else
    SUMMARY+=("FAIL  $name/$ttype — adapter exited $rc")
    FAIL=$((FAIL + 1))
  fi
done <<< "$WORK_ROWS"

# ---------------------------------------------------------------------------
# Summary report.
# ---------------------------------------------------------------------------
echo ""
echo "Harness compile summary (project root: $PROJECT_ROOT):"
for line in "${SUMMARY[@]}"; do
  echo "  $line"
done
echo "  ----"
echo "  $TOTAL targets — $OK ok, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
