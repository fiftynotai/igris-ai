#!/bin/bash

# Description: Orchestrate harness regeneration. Reads harness-manifest.json
#              and, for each agent/target, invokes the matching per-target
#              sync adapter (sync_claude_agents.sh / sync_codex_agents.sh) to
#              regenerate the harness file from its canonical prompt (TD-021).
# Usage: compile_harnesses.sh --project-root <dir> [options]
#   --project-root <dir>   - REQUIRED. Root that canonical/target paths in the
#                            manifest resolve against.
#   --manifest <path>      - Manifest file. Default: <project-root>/
#                            harness-manifest.json (FR-136: each project ships
#                            its own data manifest; core ships only the schema).
#   --overlay <path>       - OPTIONAL Layer-2 personal-overlay manifest whose
#                            agents[] are merged into the base before flatten
#                            (FR-136 base+overlay seam; FR-139 registry seam).
#                            Default: auto-discover
#                            <brain>/registry/harness-manifest.personal.json
#                            if present (absent is the normal case).
#   --filter <name-glob>   - Only process agents whose name matches the glob
#                            (shell case-glob, e.g. 'content-*'). Default: all.
#   --target claude|codex|gemini|all - Restrict to one target type. Default: all.
#                            Applies to BOTH agent targets and skills-surface
#                            targets (FR-137).
#   --surface agents|skills|all - Restrict to one projection surface (FR-137).
#                            Default: all. `agents` = the per-agent harnesses;
#                            `skills` = the surfaces.skills projection.
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

readonly SCHEMA="$ADAPTER_DIR/manifest.schema.json"
# FR-137: the core-owned Layer-1 surface declaration (skills). The compiler
# unions its surfaces with any surfaces the merged agent manifest carries.
readonly CORE_SURFACES="$ADAPTER_DIR/surfaces-manifest.json"

# Resolve the runtime brain dir like the brain MCP / verify_mirror.sh do:
# honor IGRIS_BRAIN_DIR, else ~/.igris. The personal overlay (FR-139 seam)
# lives under <brain>/registry/ and is OPTIONAL (absent is the normal case).
BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
readonly DEFAULT_OVERLAY="$BRAIN_DIR/registry/harness-manifest.personal.json"

# ---------------------------------------------------------------------------
# usage — prints usage and exits with code 2.
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 --project-root <dir> [--manifest <path>] [--overlay <path>]" >&2
  echo "                          [--filter <name-glob>] [--target claude|codex|gemini|all]" >&2
  echo "                          [--surface agents|skills|all]" >&2
  echo "" >&2
  echo "Regenerates harness files declared in the manifest from canonical prompts." >&2
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
TARGET_KIND="all"
SURFACE_KIND="all"

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
    --target)
      TARGET_KIND="${2:-}"
      shift 2 || usage
      ;;
    --surface)
      SURFACE_KIND="${2:-}"
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

# Resolve project root to an absolute path.
PROJECT_ROOT="$( cd "$PROJECT_ROOT" && pwd )"

# FR-136 manifest resolution: default to <project-root>/harness-manifest.json
# (each project ships its own data manifest). NO fallback to the old
# next-to-script location - if the resolved manifest is absent, fail with a
# clear, actionable error naming the path and the override flag.
if [ -z "$MANIFEST" ]; then
  MANIFEST="$PROJECT_ROOT/harness-manifest.json"
fi
if [ ! -f "$MANIFEST" ]; then
  echo "Error: harness manifest not found at $MANIFEST; pass --manifest <path>" >&2
  exit 1
fi

case "$TARGET_KIND" in
  claude|codex|gemini|all) : ;;
  *)
    echo "Error: --target must be claude, codex, gemini, or all (got '$TARGET_KIND')" >&2
    usage
    ;;
esac

case "$SURFACE_KIND" in
  agents|skills|all) : ;;
  *)
    echo "Error: --surface must be agents, skills, or all (got '$SURFACE_KIND')" >&2
    usage
    ;;
esac

# FR-136 overlay resolution: an explicit --overlay wins; otherwise auto-discover
# the personal overlay in the runtime registry (OPTIONAL - absent is normal).
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

# Validate the base manifest against the schema (FR-136). validate_manifest
# never no-ops: jsonschema when importable, structural check otherwise.
if ! validate_manifest "$MANIFEST" "$SCHEMA"; then
  exit 1
fi
if [ -n "$OVERLAY" ] && ! validate_manifest "$OVERLAY" "$SCHEMA"; then
  exit 1
fi

# Merge base + optional personal overlay (FR-136 base+overlay seam; FR-139
# registry seam). A name collision between an overlay (personal) agent and a
# base (core) agent is a HARD ERROR. The merged manifest is written to a temp
# file that the python3 flatten step below reads.
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
# Flatten the manifest into tab-separated work rows via python3:
#   name <TAB> versioned <TAB> canon-dir <TAB> canon-glob-or-file <TAB>
#   body-exception-or-empty <TAB> target-type <TAB> target-path
# One row per agent/target. python3 (no jq) per the _common.sh convention.
# ---------------------------------------------------------------------------
if [ "$SURFACE_KIND" = "skills" ]; then
  WORK_ROWS=""
else
  WORK_ROWS=$(python3 - "$MERGED_MANIFEST" "$FILTER" "$TARGET_KIND" <<'PY'
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
fi

# ---------------------------------------------------------------------------
# Process each work row. Accumulators span BOTH the agents surface (this loop)
# and the skills surface (the FR-137 pass below).
# ---------------------------------------------------------------------------
TOTAL=0
OK=0
FAIL=0
SUMMARY=()

if [ -n "$WORK_ROWS" ]; then
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
fi

# ---------------------------------------------------------------------------
# FR-137: skills-surface pass. Union the skills targets declared in the core
# surfaces-manifest.json with any the merged agent manifest carries, then for
# each target invoke the matching md_to_* compiler/converter (D-4:
# invoke-from-compiler — the emit logic lives in those scripts, unchanged).
# Skipped entirely when --surface agents.
# ---------------------------------------------------------------------------
if [ "$SURFACE_KIND" != "agents" ]; then
  # Flatten skills targets from both sources into rows:
  #   source <TAB> type <TAB> method <TAB> path
  # `-` is the empty-source sentinel (caller falls back to md_to_*'s default).
  SKILL_ROWS=$(python3 - "$CORE_SURFACES" "$MERGED_MANIFEST" "$TARGET_KIND" "$PROJECT_ROOT" <<'PY'
import json
import os
import sys

core_surfaces_path = sys.argv[1]
agent_manifest_path = sys.argv[2]
target_kind = sys.argv[3]
project_root = sys.argv[4]


def load_skills(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError:
        return None
    return (data.get("surfaces") or {}).get("skills")


# The core surfaces-manifest.json declares GLOBAL Layer-1 skills. It is only
# unioned when the project being compiled OWNS it (its realpath is under
# --project-root) — i.e. when compiling the igris-core repo itself. For any
# other project, only that project's own (merged) manifest surfaces apply, so
# core skills never leak into an unrelated project's projection.
sources = [agent_manifest_path]
try:
    cs_real = os.path.realpath(core_surfaces_path)
    pr_real = os.path.realpath(project_root)
    if os.path.commonpath([cs_real, pr_real]) == pr_real:
        sources.insert(0, core_surfaces_path)
except (OSError, ValueError):
    pass

seen_paths = set()
# Core surfaces own the core skills; the merged agent manifest (incl. the
# FR-139 personal overlay) contributes project + personal skills. Core first.
for src in sources:
    skills = load_skills(src)
    if not skills:
        continue
    source = skills.get("source", "") or "-"
    for t in skills.get("targets", []):
        ttype = t.get("type", "")
        if target_kind != "all" and ttype != target_kind:
            continue
        path = t.get("path", "")
        dedup_key = (ttype, path)
        if dedup_key in seen_paths:
            continue
        seen_paths.add(dedup_key)
        print("\t".join([source, ttype, t.get("method", ""), path]))
PY
)

  if [ -n "$SKILL_ROWS" ]; then
    while IFS=$'\t' read -r s_source s_type s_method s_path; do
      [ -z "$s_type" ] && continue
      TOTAL=$((TOTAL + 1))

      # Resolve the skills source: `~`/absolute used verbatim, else relative
      # to --project-root. `-` means "let the md_to_* default apply".
      src_abs=""
      if [ -n "$s_source" ] && [ "$s_source" != "-" ]; then
        case "$s_source" in
          "~"/*) src_abs="$HOME/${s_source#"~/"}" ;;
          /*)    src_abs="$s_source" ;;
          *)     src_abs="$PROJECT_ROOT/$s_source" ;;
        esac
      fi

      # Resolve the output path the same way (codex AGENTS.md is typically
      # project-relative; gemini commands dir is typically `~/.gemini/...`).
      case "$s_path" in
        "~"/*) out_abs="$HOME/${s_path#"~/"}" ;;
        /*)    out_abs="$s_path" ;;
        *)     out_abs="$PROJECT_ROOT/$s_path" ;;
      esac

      rc=0
      case "$s_type/$s_method" in
        codex/compiler)
          if [ -n "$src_abs" ]; then
            bash "$ADAPTER_DIR/md_to_agents_md.sh" "$out_abs" "$src_abs" || rc=$?
          else
            bash "$ADAPTER_DIR/md_to_agents_md.sh" "$out_abs" || rc=$?
          fi
          ;;
        gemini/converter)
          # Per-skill conversion: one {name}.toml per {name}/SKILL.md.
          conv_root="${src_abs:-$HOME/.igris/core/skills}"
          if [ ! -d "$conv_root" ]; then
            SUMMARY+=("FAIL  skills/$s_type — skills root missing: $conv_root")
            FAIL=$((FAIL + 1))
            continue
          fi
          mkdir -p "$out_abs"
          while IFS= read -r -d '' skill_md; do
            skill_name="$(basename "$(dirname "$skill_md")")"
            bash "$ADAPTER_DIR/md_to_gemini_toml.sh" \
              "$skill_md" "$out_abs/$skill_name.toml" || rc=$?
          done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                     -name 'SKILL.md' -print0 | sort -z)
          ;;
        *)
          SUMMARY+=("FAIL  skills/$s_type — unsupported type/method '$s_type/$s_method'")
          FAIL=$((FAIL + 1))
          continue
          ;;
      esac

      if [ "$rc" -eq 0 ]; then
        SUMMARY+=("OK    skills/$s_type ($s_method) -> $s_path")
        OK=$((OK + 1))
      else
        SUMMARY+=("FAIL  skills/$s_type — adapter exited $rc")
        FAIL=$((FAIL + 1))
      fi
    done <<< "$SKILL_ROWS"
  fi
fi

if [ "$TOTAL" -eq 0 ]; then
  echo "No agent/skills targets matched (filter='$FILTER', target='$TARGET_KIND', surface='$SURFACE_KIND')." >&2
  exit 0
fi

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
