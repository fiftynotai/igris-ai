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
#
# FR-137 / FR-153 SKILLS SURFACE: after the agent loop, the guard also drift-
# checks the surfaces.skills targets — all three harnesses (claude/codex/gemini)
# project per-skill registry-anchored symlinks. The verdict is by target-path
# realpath against the registry-vendored skill dir (L-515 containment), NOT a
# body sha (the legacy AGENTS.md aggregator + per-skill TOML converter that
# needed date-stripped sha compares were retired by FR-153).

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the adapter directory and shared helpers.
# ---------------------------------------------------------------------------
ADAPTER_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=_common.sh
source "$ADAPTER_DIR/_common.sh"

readonly SCHEMA="$ADAPTER_DIR/manifest.schema.json"
# FR-137: core-owned skills surface declaration, unioned with the merged agent
# manifest's surfaces (mirrors compile_harnesses.sh).
readonly CORE_SURFACES="$ADAPTER_DIR/surfaces-manifest.json"

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

# FR-152: arm the EXIT trap BEFORE allocating the tempfile so an `exit 1` from
# a downstream merge failure still cleans up. Same trap-order discipline as
# compile_harnesses.sh under FR-152.
TMP_MERGED=""
# Force return 0 from the trap (a trailing failing `[ -n ... ] && ...` would
# propagate as the script's exit status under `set -e` and turn a clean success
# into 1). See FR-152 + the matching compile_harnesses.sh trap.
_drift_cleanup() {
  if [ -n "$TMP_MERGED" ]; then
    rm -f "$TMP_MERGED"
  fi
  return 0
}
trap '_drift_cleanup' EXIT

# Merge base + optional personal overlay (collision = hard error).
MERGED_MANIFEST="$MANIFEST"
if [ -n "$OVERLAY" ]; then
  # FR-152: drop the .json suffix — BSD mktemp on macOS treats only trailing X's
  # as a template; a suffix makes the literal filename and leaks across runs.
  TMP_MERGED="$(mktemp "${TMPDIR:-/tmp}/igris-harness-merged.XXXXXX")"
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
# verify_md_agent_symlink_drift <name> <harness_label> <target_abs>
#
# FR-152 unified drift verdict for claude + gemini AGENT targets. Both share
# the same registry-resident `<BRAIN_DIR>/registry/agents/<name>/harness.md`
# expected file (the assembly happens at compile time). Verdicts:
#
#   MISSING — target absent.
#   DRIFTED — target is a regular file (refuse-to-clobber posture; the
#             compile-side Case C is retired by FR-152, with the legacy
#             body-refresh adapter).
#   DRIFTED — target is a symlink resolving outside the registry (legacy
#             reference-mode state — run `igris harness compile` to migrate).
#   DRIFTED — symlink resolves under the registry but to the WRONG file
#             (registry-anchored but mismatched).
#   DRIFTED — symlink broken.
#   MATCH   — symlink resolves to the expected harness.md.
#
# Pairs line-for-line with `compile_md_agent_target` in compile_harnesses.sh.
# Updates MATCH/DRIFT counters (caller-scoped). Both sides realpath'd for the
# macOS `/var` → `/private/var` prefix. See L-515, L-519 §18.1.
# ---------------------------------------------------------------------------
verify_md_agent_symlink_drift() {
  local name="$1"
  local harness_label="$2"
  local target_abs="$3"

  local expected_target="$BRAIN_DIR/registry/agents/$name/harness.md"

  if [ ! -e "$target_abs" ] && [ ! -L "$target_abs" ]; then
    echo "  [$name/$harness_label] MISSING — harness symlink absent: $target_abs"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  if [ ! -L "$target_abs" ]; then
    # Regular file (or other non-symlink shape) → refuse-to-clobber DRIFTED.
    echo "  [$name/$harness_label] DRIFTED"
    echo "      target    : $target_abs"
    echo "      reason    : non-symlink target — remove manually if it should be a registry-anchored symlink (FR-152 retired the body-refresh back-compat)"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  local resolved
  resolved=$(realpath "$target_abs" 2>/dev/null || true)
  if [ -z "$resolved" ]; then
    echo "  [$name/$harness_label] DRIFTED"
    echo "      symlink target: $target_abs → $(readlink "$target_abs" 2>/dev/null || echo "?") [broken]"
    echo "      reason    : $harness_label symlink target is broken (resolves to nothing)"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  local registry_real expected_real
  registry_real=$(realpath "$BRAIN_DIR/registry" 2>/dev/null || echo "$BRAIN_DIR/registry")
  expected_real=$(realpath "$expected_target" 2>/dev/null || echo "$expected_target")

  case "$resolved" in
    "$registry_real"/*|"$registry_real")
      if [ "$resolved" = "$expected_real" ]; then
        echo "  [$name/$harness_label] MATCH"
        echo "      expected  : $expected_target"
        echo "      symlink target: $target_abs → $resolved [registry-anchored]"
        MATCH=$((MATCH + 1))
      else
        echo "  [$name/$harness_label] DRIFTED"
        echo "      expected  : $expected_target"
        echo "      symlink target: $target_abs → $resolved [registry-anchored but mismatched]"
        echo "      reason    : $harness_label symlink registry-anchored but points at the wrong file (got: $resolved, expected: $expected_real)"
        DRIFT=$((DRIFT + 1))
      fi
      ;;
    *)
      echo "  [$name/$harness_label] DRIFTED"
      echo "      expected  : $expected_target"
      echo "      symlink target: $target_abs → $resolved"
      echo "      reason    : $harness_label symlink target not registry-anchored (legacy reference-mode state — run \`igris harness compile\` to migrate)"
      DRIFT=$((DRIFT + 1))
      ;;
  esac
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
    # FR-144: propagate `layer` as the last column so body-exception sidecar
    # resolution can be keyed on it (core -> in-repo, personal -> registry).
    # Defaults to non-empty "core", so no `-` sentinel / tab-collapse risk.
    layer = agent.get("layer", "") or "core"
    for target in agent.get("targets", []):
        print("\t".join([
            name, versioned, canon_dir, canon_ref, body_exc,
            target["type"], target["path"], layer,
        ]))
PY
)

# ---------------------------------------------------------------------------
# Check each work row. Accumulators span BOTH the agents surface (this loop)
# and the skills surface (the FR-137 pass below).
# ---------------------------------------------------------------------------
TOTAL=0
MATCH=0
DRIFT=0

echo "Harness drift check (project root: $PROJECT_ROOT):"
echo ""

if [ -n "$WORK_ROWS" ]; then
while IFS=$'\t' read -r name versioned canon_dir canon_ref body_exc ttype target_path layer; do
  [ -z "$name" ] && continue
  TOTAL=$((TOTAL + 1))

  # Resolve canonical. An absolute or `~`-prefixed canon_dir is used verbatim
  # (FR-142 copy-vendor points canonical.dir at the vendored copy under
  # ~/.igris/registry/<name>/); a relative dir is project-relative. Mirrors the
  # canonical resolution in compile_harnesses.sh.
  case "$canon_dir" in
    "~"/*) canon_base="$HOME/${canon_dir#"~/"}" ;;
    /*)    canon_base="$canon_dir" ;;
    *)     canon_base="$PROJECT_ROOT/$canon_dir" ;;
  esac

  # Resolve canonical.
  canon_abs=""
  if [ "$versioned" = "1" ]; then
    if ! canon_abs=$(latest_canonical "$canon_base" "$canon_ref"); then
      echo "  [$name/$ttype] MISSING — no canonical match for '$canon_ref' in $canon_dir"
      DRIFT=$((DRIFT + 1))
      continue
    fi
  else
    canon_abs="$canon_base/$canon_ref"
    if [ ! -f "$canon_abs" ]; then
      echo "  [$name/$ttype] MISSING — canonical file absent: $canon_abs"
      DRIFT=$((DRIFT + 1))
      continue
    fi
  fi

  # Resolve the body-exception sidecar.
  # FR-144: resolution is LAYER-KEYED (not fallback). A `layer:"personal"`
  # agent's sidecar lives in the runtime registry (Layer-2,
  # <brain>/registry/body-exceptions/, honoring IGRIS_BRAIN_DIR); a core
  # agent's sidecar lives in-repo alongside the adapter (Layer-1, unchanged).
  # Keying on layer (rather than try-registry-then-repo) keeps provenance
  # one-directional: a re-introduced repo sidecar can never serve a personal
  # agent — closing the L-498 leak this brief addresses.
  exc_abs=""
  if [ -n "$body_exc" ] && [ "$body_exc" != "-" ]; then
    if [ "$layer" = "personal" ]; then
      exc_abs="$BRAIN_DIR/registry/body-exceptions/$body_exc.json"
    else
      exc_abs="$ADAPTER_DIR/body-exceptions/$body_exc.json"
    fi
    if [ ! -f "$exc_abs" ]; then
      echo "  [$name/$ttype] MISSING — body-exception sidecar absent: $exc_abs"
      DRIFT=$((DRIFT + 1))
      continue
    fi
  fi

  # FR-154: agent target.path resolution mirrors the skills 3-case resolver
  # (compile_harnesses.sh:763 / check_harness_drift.sh parity). `~/...` expands
  # against $HOME, `/abs/...` is honored verbatim, anything else is taken as
  # project-relative. Compile sibling carries the identical block.
  case "$target_path" in
    "~"/*) target_abs="$HOME/${target_path#"~/"}" ;;
    /*)    target_abs="$target_path" ;;
    *)     target_abs="$PROJECT_ROOT/$target_path" ;;
  esac
  canon_version=$(read_canonical_version "$canon_abs")

  # FR-152: claude + gemini AGENT verdicts are by target-path realpath against
  # the registry-resident assembled harness.md (NOT body sha). Pair line-for-
  # line with `compile_md_agent_target` (L-519 §18.1 compile/drift-verify
  # pairing). Both sides of the containment check are realpath'd so macOS
  # `/var` → `/private/var` (and similar symlink-resolved TMPDIR prefixes) do
  # not produce false "not registry-anchored" verdicts.
  if [ "$ttype" = "claude" ] || [ "$ttype" = "gemini" ]; then
    verify_md_agent_symlink_drift "$name" "$ttype" "$target_abs"
    continue
  fi

  # codex-only branch from here on. Body-exception is claude-only at the
  # SYMBOLIC level (TD-193 gate); codex emitters write the plain canonical
  # body so the expected body is `strip_frontmatter "$canon_abs"`.
  expected_body=$(strip_frontmatter "$canon_abs")
  expected_sha=$(sha_of_string "$expected_body")

  # Resolve the actual codex body (decoded developer_instructions).
  actual_body=""
  if [ "$ttype" = "codex" ]; then
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
fi

# ---------------------------------------------------------------------------
# FR-137: skills-surface drift pass. For each skills target (unioned from the
# core surfaces-manifest.json and the merged agent manifest), re-derive the
# projected artifact to a temp file via the md_to_* compiler and compare
# against on-disk. The compiler IS the canonical-deriver. For the AGENTS.md
# compiler target the trailing date-stamped marker line is stripped from BOTH
# sides before sha so the verdict is date-stable.
# ---------------------------------------------------------------------------
SKILL_ROWS=$(python3 - "$CORE_SURFACES" "$MERGED_MANIFEST" "$PROJECT_ROOT" <<'PY'
import json
import os
import sys


def load_skills(path):
    # TD-191: returns a LIST of skills blocks (mirrors compile_harnesses.sh's
    # loader). Legacy single-object normalized to `[object]`; missing → [].
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError:
        return []
    value = (data.get("surfaces") or {}).get("skills")
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return value
    return []


# Only union the GLOBAL core surfaces-manifest.json when the checked project
# OWNS it (realpath under --project-root) — see compile_harnesses.sh. This
# keeps core skills from being flagged against unrelated project roots.
sources = [sys.argv[2]]
try:
    cs_real = os.path.realpath(sys.argv[1])
    pr_real = os.path.realpath(sys.argv[3])
    if os.path.commonpath([cs_real, pr_real]) == pr_real:
        sources.insert(0, sys.argv[1])
except (OSError, ValueError):
    pass

# TD-191: NO `seen` dedup here. The drift pass mirrors compile_harnesses.sh
# (L-519 §18.1 compile/drift-verify pairing) — every (block, target) row
# that passes the merge's cross-block path-collision guard is legitimately
# distinct. A `seen` dedup would mask a legitimate multi-block target row.
for src in sources:
    for block in load_skills(src):
        if not isinstance(block, dict):
            continue
        source = block.get("source", "") or "-"
        for t in block.get("targets", []) or []:
            print("\t".join([
                source,
                (t or {}).get("type", ""),
                (t or {}).get("method", ""),
                (t or {}).get("path", ""),
            ]))
PY
)

if [ -n "$SKILL_ROWS" ]; then
  while IFS=$'\t' read -r s_source s_type s_method s_path; do
    [ -z "$s_type" ] && continue
    TOTAL=$((TOTAL + 1))

    # Resolve source (`~`/absolute verbatim, else project-relative; `-`=default).
    src_abs=""
    if [ -n "$s_source" ] && [ "$s_source" != "-" ]; then
      case "$s_source" in
        "~"/*) src_abs="$HOME/${s_source#"~/"}" ;;
        /*)    src_abs="$s_source" ;;
        *)     src_abs="$PROJECT_ROOT/$s_source" ;;
      esac
    fi
    case "$s_path" in
      "~"/*) out_abs="$HOME/${s_path#"~/"}" ;;
      /*)    out_abs="$s_path" ;;
      *)     out_abs="$PROJECT_ROOT/$s_path" ;;
    esac

    verdict="MATCH"
    reason=""
    case "$s_type/$s_method" in
      claude/symlink)
        # FR-149/FR-153: per-skill symlinks under <out_abs>/<name> pointing at
        # <src_abs>/<name>. Verdict by target-path realpath + L-515 registry
        # containment. Pairs line-for-line with the compile-side branch
        # (L-519 §18.1) — every <name>/SKILL.md walked at compile time must
        # have a registry-anchored symlink under out_abs at drift time.
        # Both sides of the containment check are realpath'd so macOS `/var`
        # → `/private/var` does not produce false "not registry-anchored".
        conv_root="${src_abs:-$HOME/.igris/core/skills}"
        if [ ! -d "$conv_root" ]; then
          echo "  [skills/$s_type] MISSING — skills root absent: $conv_root"
          DRIFT=$((DRIFT + 1))
          continue
        fi
        registry_real=$(realpath "$BRAIN_DIR/registry" 2>/dev/null || echo "$BRAIN_DIR/registry")
        any_missing=0
        any_drift=0
        any_unanchored=0
        any_realfile=0
        checked=0
        while IFS= read -r -d '' skill_md; do
          skill_name="$(basename "$(dirname "$skill_md")")"
          skill_dir="$(dirname "$skill_md")"
          skill_dir_real=$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")
          link_path="$out_abs/$skill_name"
          if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
            any_missing=1
          elif [ -L "$link_path" ]; then
            resolved=$(realpath "$link_path" 2>/dev/null || true)
            if [ -z "$resolved" ]; then
              any_drift=1
            else
              case "$resolved" in
                "$registry_real"/*|"$registry_real")
                  if [ "$resolved" != "$skill_dir_real" ]; then
                    any_drift=1
                  fi
                  ;;
                *)
                  any_unanchored=1
                  ;;
              esac
            fi
          else
            # Not a symlink — a regular file/dir at the symlink target. Treated
            # as drift: the symlink mechanism is not in effect.
            any_realfile=1
          fi
          checked=$((checked + 1))
        done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                   -name 'SKILL.md' -print0 | sort -z)
        if [ "$any_missing" -eq 1 ]; then
          verdict="MISSING"
          reason="one or more claude skill symlinks absent"
        elif [ "$any_realfile" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more target paths are regular files/dirs, not symlinks (legacy reference-mode state — remove manually, then run \`igris harness compile\`)"
        elif [ "$any_unanchored" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more claude skill symlinks not registry-anchored (legacy reference-mode state — run \`igris harness compile\` to migrate)"
        elif [ "$any_drift" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more claude skill symlinks point at the wrong canonical (registry-anchored but mismatched)"
        fi
        echo "  [skills/$s_type] $verdict"
        echo "      source     : $conv_root"
        echo "      artifact dir: $out_abs ($checked skills checked)"
        ;;
      codex/symlink)
        # FR-153: per-skill symlinks (codex). Mirror of claude/symlink + one
        # additional codex-only verdict: literal symlink target must be
        # ABSOLUTE (D2). Codex resolves relative-path symlinks from cwd —
        # POSIX-incorrect — so a realpath-resolves-correctly relative symlink
        # is still a drift hazard. See L-519 §18.1.
        conv_root="${src_abs:-$HOME/.igris/core/skills}"
        if [ ! -d "$conv_root" ]; then
          echo "  [skills/$s_type] MISSING — skills root absent: $conv_root"
          DRIFT=$((DRIFT + 1))
          continue
        fi
        registry_real=$(realpath "$BRAIN_DIR/registry" 2>/dev/null || echo "$BRAIN_DIR/registry")
        any_missing=0
        any_drift=0
        any_unanchored=0
        any_realfile=0
        any_relative_codex=0
        checked=0
        while IFS= read -r -d '' skill_md; do
          skill_name="$(basename "$(dirname "$skill_md")")"
          skill_dir="$(dirname "$skill_md")"
          skill_dir_real=$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")
          link_path="$out_abs/$skill_name"
          if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
            any_missing=1
          elif [ -L "$link_path" ]; then
            # FR-153 D2: literal target must be absolute (codex re-resolves
            # relative symlinks from cwd). Check readlink BEFORE realpath.
            literal=$(readlink "$link_path" 2>/dev/null || true)
            case "$literal" in
              /*) : ;;
              *) any_relative_codex=1 ;;
            esac
            resolved=$(realpath "$link_path" 2>/dev/null || true)
            if [ -z "$resolved" ]; then
              any_drift=1
            else
              case "$resolved" in
                "$registry_real"/*|"$registry_real")
                  if [ "$resolved" != "$skill_dir_real" ]; then
                    any_drift=1
                  fi
                  ;;
                *)
                  any_unanchored=1
                  ;;
              esac
            fi
          else
            any_realfile=1
          fi
          checked=$((checked + 1))
        done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                   -name 'SKILL.md' -print0 | sort -z)
        if [ "$any_missing" -eq 1 ]; then
          verdict="MISSING"
          reason="one or more codex skill symlinks absent"
        elif [ "$any_realfile" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more target paths are regular files/dirs, not symlinks (legacy reference-mode state — remove manually, then run \`igris harness compile\`)"
        elif [ "$any_unanchored" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more codex skill symlinks not registry-anchored (legacy reference-mode state — run \`igris harness compile\` to migrate)"
        elif [ "$any_drift" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more codex skill symlinks point at the wrong canonical (registry-anchored but mismatched)"
        elif [ "$any_relative_codex" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more codex skill symlinks have a relative target (codex resolves these from cwd, not symlink location — FR-153 D2)"
        fi
        echo "  [skills/$s_type] $verdict"
        echo "      source     : $conv_root"
        echo "      artifact dir: $out_abs ($checked skills checked)"
        ;;
      gemini/symlink)
        # FR-153: per-skill symlinks (gemini). Exact mirror of claude/symlink
        # (no codex absolute-path guard). See L-519 §18.1.
        conv_root="${src_abs:-$HOME/.igris/core/skills}"
        if [ ! -d "$conv_root" ]; then
          echo "  [skills/$s_type] MISSING — skills root absent: $conv_root"
          DRIFT=$((DRIFT + 1))
          continue
        fi
        registry_real=$(realpath "$BRAIN_DIR/registry" 2>/dev/null || echo "$BRAIN_DIR/registry")
        any_missing=0
        any_drift=0
        any_unanchored=0
        any_realfile=0
        checked=0
        while IFS= read -r -d '' skill_md; do
          skill_name="$(basename "$(dirname "$skill_md")")"
          skill_dir="$(dirname "$skill_md")"
          skill_dir_real=$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")
          link_path="$out_abs/$skill_name"
          if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
            any_missing=1
          elif [ -L "$link_path" ]; then
            resolved=$(realpath "$link_path" 2>/dev/null || true)
            if [ -z "$resolved" ]; then
              any_drift=1
            else
              case "$resolved" in
                "$registry_real"/*|"$registry_real")
                  if [ "$resolved" != "$skill_dir_real" ]; then
                    any_drift=1
                  fi
                  ;;
                *)
                  any_unanchored=1
                  ;;
              esac
            fi
          else
            any_realfile=1
          fi
          checked=$((checked + 1))
        done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                   -name 'SKILL.md' -print0 | sort -z)
        if [ "$any_missing" -eq 1 ]; then
          verdict="MISSING"
          reason="one or more gemini skill symlinks absent"
        elif [ "$any_realfile" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more target paths are regular files/dirs, not symlinks (legacy reference-mode state — remove manually, then run \`igris harness compile\`)"
        elif [ "$any_unanchored" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more gemini skill symlinks not registry-anchored (legacy reference-mode state — run \`igris harness compile\` to migrate)"
        elif [ "$any_drift" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more gemini skill symlinks point at the wrong canonical (registry-anchored but mismatched)"
        fi
        echo "  [skills/$s_type] $verdict"
        echo "      source     : $conv_root"
        echo "      artifact dir: $out_abs ($checked skills checked)"
        ;;
      *)
        verdict="DRIFTED"
        reason="unsupported type/method '$s_type/$s_method'"
        echo "  [skills/$s_type] $verdict"
        ;;
    esac

    if [ "$verdict" = "MATCH" ]; then
      MATCH=$((MATCH + 1))
    else
      echo "      reason     : $reason"
      DRIFT=$((DRIFT + 1))
    fi
  done <<< "$SKILL_ROWS"
fi

if [ "$TOTAL" -eq 0 ]; then
  echo "No agent/skills targets matched (filter='$FILTER')." >&2
  exit 0
fi

echo ""
echo "  ----"
echo "  $TOTAL targets — $MATCH in sync, $DRIFT drifted/missing"

if [ "$DRIFT" -gt 0 ]; then
  exit 1
fi
exit 0
