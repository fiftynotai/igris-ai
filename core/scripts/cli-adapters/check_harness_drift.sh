#!/bin/bash

# Description: CI-style drift guard for agent-prompt harness files. For every
#              agent/target in the manifest, compares the harness body against
#              the canonical prompt body (sha + version marker). Exits non-zero
#              if ANY harness is out-of-sync (TD-021).
# Usage: check_harness_drift.sh --project-root <dir> [--manifest <path>] [--overlay <path>] [--filter <name-glob>]
#   --project-root <dir>  - REQUIRED. Root that manifest paths resolve against.
#   --manifest <path>     - Manifest file. Default: <project-root>/
#                           harness-manifest.json (FR-136: each project ships
#                           its own data manifest).
#   --overlay <path>      - OPTIONAL Layer-2 personal-overlay manifest merged
#                           into the base before flatten (FR-136 base+overlay
#                           seam). Default: auto-discover
#                           <brain>/registry/harness-manifest.personal.json.
#   --filter <name-glob>  - Only check agents whose name matches the glob.
# Dependencies: python3, _common.sh (auto-sourced from script dir)
# Exit codes:
#   0 - All checked harness targets are in sync with canonical
#   1 - One or more harness targets DRIFTED or MISSING
#   2 - Usage error (bad/missing arguments)
#
# The report is self-evidencing in the spirit of verify_mirror.sh: for every
# target it prints the canonical body sha, the harness body sha, both version
# markers, and a per-target verdict (MATCH / DRIFTED / MISSING). The exit code
# cannot be misread as PASS unless every target shows MATCH.
#
# CODEX TARGETS: the harness body for codex is the decoded
# `developer_instructions` value from the TOML. The leading GENERATED-MARKER
# comment is not part of that value, so it does not affect the sha compare.

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the adapter directory and shared helpers.
# ---------------------------------------------------------------------------
ADAPTER_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=_common.sh
source "$ADAPTER_DIR/_common.sh"

readonly SCHEMA="$ADAPTER_DIR/manifest.schema.json"

# Resolve the runtime brain dir (IGRIS_BRAIN_DIR, else ~/.igris) to locate the
# OPTIONAL personal overlay (FR-139 seam) under <brain>/registry/.
BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
readonly DEFAULT_OVERLAY="$BRAIN_DIR/registry/harness-manifest.personal.json"

# ---------------------------------------------------------------------------
# usage — prints usage and exits with code 2.
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 --project-root <dir> [--manifest <path>] [--overlay <path>] [--filter <name-glob>]" >&2
  echo "" >&2
  echo "Fails (exit 1) if any harness file has drifted from its canonical prompt." >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
PROJECT_ROOT=""
MANIFEST=""
OVERLAY=""
OVERLAY_SET=0
FILTER='*'

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
    --overlay)
      OVERLAY="${2:-}"
      OVERLAY_SET=1
      shift 2 || usage
      ;;
    --filter)
      FILTER="${2:-}"
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

PROJECT_ROOT="$( cd "$PROJECT_ROOT" && pwd )"

# FR-136 manifest resolution: default to <project-root>/harness-manifest.json,
# NO fallback to the old next-to-script location. Fail clearly if absent.
if [ -z "$MANIFEST" ]; then
  MANIFEST="$PROJECT_ROOT/harness-manifest.json"
fi
if [ ! -f "$MANIFEST" ]; then
  echo "Error: harness manifest not found at $MANIFEST; pass --manifest <path>" >&2
  exit 1
fi

# FR-136 overlay resolution (explicit --overlay wins, else auto-discover).
if [ "$OVERLAY_SET" -eq 0 ]; then
  if [ -f "$DEFAULT_OVERLAY" ]; then
    OVERLAY="$DEFAULT_OVERLAY"
  else
    OVERLAY=""
  fi
elif [ -n "$OVERLAY" ] && [ ! -f "$OVERLAY" ]; then
  echo "Error: overlay manifest not found at $OVERLAY" >&2
  exit 1
fi

# Validate base (+ overlay) against the schema; never no-ops.
if ! validate_manifest "$MANIFEST" "$SCHEMA"; then
  exit 1
fi
if [ -n "$OVERLAY" ] && ! validate_manifest "$OVERLAY" "$SCHEMA"; then
  exit 1
fi

# Merge base + optional personal overlay (collision = hard error).
MERGED_MANIFEST="$MANIFEST"
TMP_MERGED=""
if [ -n "$OVERLAY" ]; then
  TMP_MERGED="$(mktemp "${TMPDIR:-/tmp}/igris-harness-merged.XXXXXX.json")"
  trap 'rm -f "$TMP_MERGED"' EXIT
  if ! merge_overlay_manifest "$MANIFEST" "$OVERLAY" > "$TMP_MERGED"; then
    exit 1
  fi
  MERGED_MANIFEST="$TMP_MERGED"
fi

# ---------------------------------------------------------------------------
# canonical_body_with_exception <canonical-md> <exception-json-or-empty>
#
# Emits the canonical body, with the documented body-exception appendix
# inserted when an exception sidecar is supplied. This is the exact body the
# corresponding harness is expected to carry.
# ---------------------------------------------------------------------------
canonical_body_with_exception() {
  local canonical="$1"
  local exception="$2"
  local body
  body=$(strip_frontmatter "$canonical")
  if [ -z "$exception" ]; then
    printf '%s' "$body"
    return 0
  fi
  python3 - "$body" "$exception" <<'PY'
import json
import sys

body = sys.argv[1]
with open(sys.argv[2], "r", encoding="utf-8") as fh:
    exc = json.load(fh)
anchor = exc["anchor"]
insert_lines = exc["insert"]
lines = body.splitlines()
matches = [i for i, ln in enumerate(lines) if ln.strip() == anchor.strip()]
if len(matches) != 1:
    sys.stderr.write(
        f"Error: body-exception anchor matched {len(matches)} lines\n"
    )
    sys.exit(1)
idx = matches[0]
lines = lines[: idx + 1] + insert_lines + lines[idx + 1 :]
sys.stdout.write("\n".join(lines))
PY
}

# ---------------------------------------------------------------------------
# sha_of_string <string>  — sha256 of a literal string (no file needed).
# ---------------------------------------------------------------------------
sha_of_string() {
  python3 - "$1" <<'PY'
import hashlib
import sys
print(hashlib.sha256(sys.argv[1].encode("utf-8")).hexdigest())
PY
}

# ---------------------------------------------------------------------------
# codex_body <toml-path>  — decode developer_instructions from a codex TOML.
# Emits empty + returns 1 if the file is missing or unparseable.
# ---------------------------------------------------------------------------
codex_body() {
  local toml_path="$1"
  if [ ! -f "$toml_path" ]; then
    return 1
  fi
  python3 - "$toml_path" <<'PY'
import sys
try:
    import tomllib
except ImportError:  # python < 3.11
    sys.exit(2)
try:
    with open(sys.argv[1], "rb") as fh:
        data = tomllib.load(fh)
except Exception:
    sys.exit(1)
val = data.get("developer_instructions")
if val is None:
    sys.exit(1)
sys.stdout.write(val)
PY
}

# ---------------------------------------------------------------------------
# Flatten the manifest into work rows (same column layout as
# compile_harnesses.sh; `-` is the empty-body-exception sentinel).
# ---------------------------------------------------------------------------
WORK_ROWS=$(python3 - "$MERGED_MANIFEST" "$FILTER" <<'PY'
import fnmatch
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    manifest = json.load(fh)
name_filter = sys.argv[2]

for agent in manifest.get("agents", []):
    name = agent["name"]
    if not fnmatch.fnmatch(name, name_filter):
        continue
    canon = agent["canonical"]
    versioned = "1" if canon.get("versioned") else "0"
    canon_dir = canon["dir"]
    canon_ref = canon.get("glob", "") if canon.get("versioned") else canon.get("file", "")
    body_exc = agent.get("body_exception", "") or "-"
    for target in agent.get("targets", []):
        print("\t".join([
            name, versioned, canon_dir, canon_ref, body_exc,
            target["type"], target["path"],
        ]))
PY
)

if [ -z "$WORK_ROWS" ]; then
  echo "No agent/target rows matched (filter='$FILTER')." >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Check each work row.
# ---------------------------------------------------------------------------
TOTAL=0
MATCH=0
DRIFT=0

echo "Harness drift check (project root: $PROJECT_ROOT):"
echo ""

while IFS=$'\t' read -r name versioned canon_dir canon_ref body_exc ttype target_path; do
  [ -z "$name" ] && continue
  TOTAL=$((TOTAL + 1))

  # Resolve canonical.
  canon_abs=""
  if [ "$versioned" = "1" ]; then
    if ! canon_abs=$(latest_canonical "$PROJECT_ROOT/$canon_dir" "$canon_ref"); then
      echo "  [$name/$ttype] MISSING — no canonical match for '$canon_ref' in $canon_dir"
      DRIFT=$((DRIFT + 1))
      continue
    fi
  else
    canon_abs="$PROJECT_ROOT/$canon_dir/$canon_ref"
    if [ ! -f "$canon_abs" ]; then
      echo "  [$name/$ttype] MISSING — canonical file absent: $canon_abs"
      DRIFT=$((DRIFT + 1))
      continue
    fi
  fi

  # Resolve the body-exception sidecar.
  exc_abs=""
  if [ -n "$body_exc" ] && [ "$body_exc" != "-" ]; then
    exc_abs="$ADAPTER_DIR/body-exceptions/$body_exc.json"
    if [ ! -f "$exc_abs" ]; then
      echo "  [$name/$ttype] MISSING — body-exception sidecar absent: $exc_abs"
      DRIFT=$((DRIFT + 1))
      continue
    fi
  fi

  target_abs="$PROJECT_ROOT/$target_path"
  canon_version=$(read_canonical_version "$canon_abs")

  # Expected body = canonical body (+ exception appendix when applicable).
  expected_body=$(canonical_body_with_exception "$canon_abs" "$exc_abs")
  expected_sha=$(sha_of_string "$expected_body")

  # Resolve the actual harness body per target type.
  actual_body=""
  if [ "$ttype" = "claude" ]; then
    if [ ! -f "$target_abs" ]; then
      echo "  [$name/$ttype] MISSING — harness file absent: $target_abs"
      DRIFT=$((DRIFT + 1))
      continue
    fi
    actual_body=$(strip_frontmatter "$target_abs")
  elif [ "$ttype" = "codex" ]; then
    if ! actual_body=$(codex_body "$target_abs"); then
      echo "  [$name/$ttype] MISSING — codex harness absent or unparseable: $target_abs"
      DRIFT=$((DRIFT + 1))
      continue
    fi
  else
    echo "  [$name/$ttype] DRIFTED — unknown target type"
    DRIFT=$((DRIFT + 1))
    continue
  fi

  actual_sha=$(sha_of_string "$actual_body")
  actual_version=$(read_canonical_version "$target_abs" 2>/dev/null || true)
  # codex bodies live inside a TOML value; read_canonical_version on the .toml
  # path scans the whole file and still finds the `> **Version:**` line.

  # Verdict: sha must match; version marker must match when both present.
  verdict="MATCH"
  reason=""
  if [ "$expected_sha" != "$actual_sha" ]; then
    verdict="DRIFTED"
    reason="body sha mismatch"
  elif [ -n "$canon_version" ] && [ -n "$actual_version" ] \
       && [ "$canon_version" != "$actual_version" ]; then
    verdict="DRIFTED"
    reason="version marker mismatch"
  fi

  echo "  [$name/$ttype] $verdict"
  echo "      canonical : $canon_abs"
  echo "      harness   : $target_abs"
  echo "      canon sha : $expected_sha (version ${canon_version:-none})"
  echo "      harness sha: $actual_sha (version ${actual_version:-none})"
  if [ "$verdict" = "MATCH" ]; then
    MATCH=$((MATCH + 1))
  else
    echo "      reason    : $reason"
    DRIFT=$((DRIFT + 1))
  fi
done <<< "$WORK_ROWS"

echo ""
echo "  ----"
echo "  $TOTAL targets — $MATCH in sync, $DRIFT drifted/missing"

if [ "$DRIFT" -gt 0 ]; then
  exit 1
fi
exit 0
