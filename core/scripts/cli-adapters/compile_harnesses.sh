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
# atomic_symlink <link_path> <target>
#
# Atomically create-or-replace a symlink at $link_path pointing at $target.
# Uses temp-symlink + `os.rename(2)` — atomic on the same filesystem. Same
# atomicity primitive as the TS `vendorSurfaceAtomic` / `vendorSkillTreeAtomic`
# helpers (FR-149 D2). Discards any stale `.tmp-$$` before writing the new
# temp so a concurrent or prior-interrupted run cannot block this one.
#
# IMPORTANT — macOS `mv` BUG: on macOS the shell `mv` command, when given a
# target that is itself a symlink, FOLLOWS the symlink and renames into the
# linked-to dir instead of replacing the symlink. The kernel's `rename(2)`
# does the correct thing on both BSD and Linux, so we delegate to
# `os.rename` via python3 (which calls `rename(2)` directly).
# ---------------------------------------------------------------------------
atomic_symlink() {
  local link_path="$1"
  local target="$2"
  local tmp="${link_path}.tmp-$$"
  rm -f "$tmp"
  ln -sf "$target" "$tmp"
  python3 -c "import os, sys; os.rename(sys.argv[1], sys.argv[2])" \
    "$tmp" "$link_path"
}

# ---------------------------------------------------------------------------
# compile_claude_agent_target <name> <canon_abs> <target_abs> <exc_abs>
#
# FR-149 D3 decision tree for the claude agent target. The 3 cases produce
# registry-anchored symlinks at the target with safe back-compat:
#
#   Case A — target absent → create symlink → registry-vendored canonical.
#   Case B — target IS a symlink → if it already resolves to the canonical
#            (registry-anchored), no-op silently; else atomically repoint and
#            log the migration line.
#   Case C — target IS a regular file (NOT symlink) → fall through to the
#            legacy sync_claude_agents.sh body-refresh path (preserves
#            hand-authored real-file claude harness consumers).
#
# Any other target shape (e.g. a directory) is a hard error — refuse to
# clobber. See L-519 (the claude symlink IS the projection, anchored at the
# registry-vendored copy).
# ---------------------------------------------------------------------------
compile_claude_agent_target() {
  local name="$1"
  local canon_abs="$2"
  local target_abs="$3"
  local exc_abs="$4"

  # Case C: real file, NOT a symlink → back-compat sync.
  if [ -f "$target_abs" ] && [ ! -L "$target_abs" ]; then
    if [ -n "$exc_abs" ]; then
      bash "$ADAPTER_DIR/sync_claude_agents.sh" "$canon_abs" "$target_abs" "$exc_abs"
    else
      bash "$ADAPTER_DIR/sync_claude_agents.sh" "$canon_abs" "$target_abs"
    fi
    return $?
  fi

  # Case B: existing symlink — re-anchor or no-op.
  if [ -L "$target_abs" ]; then
    local current_target
    current_target=$(readlink "$target_abs" 2>/dev/null || true)
    local resolved
    resolved=$(realpath "$target_abs" 2>/dev/null || true)
    if [ -n "$resolved" ] && [ "$resolved" = "$canon_abs" ]; then
      return 0  # already correctly anchored — silent no-op
    fi
    mkdir -p "$(dirname "$target_abs")"
    atomic_symlink "$target_abs" "$canon_abs"
    echo "migrating legacy claude symlink: $target_abs → $canon_abs (was: $current_target)"
    return 0
  fi

  # Case A: nothing there — create.
  if [ ! -e "$target_abs" ]; then
    mkdir -p "$(dirname "$target_abs")"
    atomic_symlink "$target_abs" "$canon_abs"
    echo "creating claude symlink: $target_abs → $canon_abs"
    return 0
  fi

  # Anything else (e.g. directory) — refuse to clobber.
  echo "[$name/claude] ERROR — refuse to clobber non-symlink, non-file target: $target_abs" >&2
  return 1
}

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
    # FR-144: propagate `layer` as the last column so body-exception sidecar
    # resolution can be keyed on it (core -> in-repo, personal -> registry).
    # Defaults to non-empty "core", so no `-` sentinel / tab-collapse risk.
    layer = agent.get("layer", "") or "core"
    for target in agent.get("targets", []):
        ttype = target["type"]
        if target_kind != "all" and ttype != target_kind:
            continue
        row = "\t".join([
            name, versioned, canon_dir, canon_ref, body_exc,
            ttype, target["path"], layer,
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
while IFS=$'\t' read -r name versioned canon_dir canon_ref body_exc ttype target_path layer; do
  [ -z "$name" ] && continue
  TOTAL=$((TOTAL + 1))

  # Resolve the canonical source dir. An absolute or `~`-prefixed canon_dir is
  # used verbatim (FR-142 copy-vendor points canonical.dir at the vendored copy
  # under ~/.igris/registry/<name>/); a relative dir is project-relative. Mirrors
  # the skills-source 3-case resolution below (lines ~386-390).
  case "$canon_dir" in
    "~"/*) canon_base="$HOME/${canon_dir#"~/"}" ;;
    /*)    canon_base="$canon_dir" ;;
    *)     canon_base="$PROJECT_ROOT/$canon_dir" ;;
  esac

  # Resolve the canonical source path.
  canon_abs=""
  if [ "$versioned" = "1" ]; then
    if ! canon_abs=$(latest_canonical "$canon_base" "$canon_ref"); then
      SUMMARY+=("FAIL  $name/$ttype — no canonical match for '$canon_ref' in $canon_dir")
      FAIL=$((FAIL + 1))
      continue
    fi
  else
    canon_abs="$canon_base/$canon_ref"
    if [ ! -f "$canon_abs" ]; then
      SUMMARY+=("FAIL  $name/$ttype — canonical file missing: $canon_abs")
      FAIL=$((FAIL + 1))
      continue
    fi
  fi

  target_abs="$PROJECT_ROOT/$target_path"

  # Resolve an optional body-exception sidecar. `-` is the empty sentinel.
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
      SUMMARY+=("FAIL  $name/$ttype — body-exception sidecar missing: $exc_abs")
      FAIL=$((FAIL + 1))
      continue
    fi
  fi

  # Dispatch to the matching per-target adapter.
  rc=0
  case "$ttype" in
    claude)
      # FR-149: registry-anchored symlink for the common case, with Case C
      # back-compat fallback to sync_claude_agents.sh for hand-authored
      # real-file claude targets.
      compile_claude_agent_target "$name" "$canon_abs" "$target_abs" "$exc_abs" || rc=$?
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
    # TD-191: returns a LIST of skills blocks (always). Legacy single-object
    # `surfaces.skills` is normalized to `[object]` so back-compat overlays
    # parse without a version bump. Missing/absent → [].
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

# TD-191: NO `seen_paths` dedup here. The cross-block path-collision guard
# in `_common.sh`'s `merge_overlay_manifest` rejects any duplicate
# (block, target) path at merge time, so every row that reaches flatten is
# legitimately distinct. Keeping a dedup here would mask a legitimate
# multi-block target row (e.g., a personal block's `AGENTS-mine.md` next to
# the core block's `AGENTS-core.md`).
# Core surfaces own the core skills; the merged agent manifest (incl. the
# FR-139 personal overlay) contributes project + personal skills. Core first.
for src in sources:
    for block in load_skills(src):
        if not isinstance(block, dict):
            continue
        source = block.get("source", "") or "-"
        for t in block.get("targets", []) or []:
            ttype = (t or {}).get("type", "")
            if target_kind != "all" and ttype != target_kind:
                continue
            print("\t".join([
                source,
                ttype,
                (t or {}).get("method", ""),
                (t or {}).get("path", ""),
            ]))
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
        claude/symlink)
          # FR-149: per-skill registry-anchored symlinks. For each
          # <name>/SKILL.md under the source root, emit a symlink at
          # <out_abs>/<name> pointing at <src_abs>/<name>. Idempotent (already
          # correct → silent no-op), atomic-repoint on path change, and
          # refuse-to-clobber on a non-symlink target. See L-519.
          conv_root="${src_abs:-$HOME/.igris/core/skills}"
          if [ ! -d "$conv_root" ]; then
            SUMMARY+=("FAIL  skills/$s_type — skills root missing: $conv_root")
            FAIL=$((FAIL + 1))
            continue
          fi
          mkdir -p "$out_abs"
          while IFS= read -r -d '' skill_md; do
            skill_name="$(basename "$(dirname "$skill_md")")"
            skill_dir="$(dirname "$skill_md")"
            link_path="$out_abs/$skill_name"
            # Refuse-to-clobber: regular file or directory at the symlink
            # target — preserves operator-authored state under ~/.claude/.
            if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
              echo "[$s_type/skills/$skill_name] ERROR — refuse to clobber non-symlink at $link_path (remove manually if it should be a registry-anchored symlink)" >&2
              SUMMARY+=("FAIL  skills/$s_type/$skill_name — refuse to clobber non-symlink at $link_path")
              rc=1
              continue
            fi
            if [ -L "$link_path" ]; then
              current=$(readlink "$link_path" 2>/dev/null || true)
              if [ "$current" = "$skill_dir" ]; then
                : # already correctly anchored — silent no-op
              else
                atomic_symlink "$link_path" "$skill_dir"
                echo "migrating legacy claude skill symlink: $link_path → $skill_dir (was: $current)"
              fi
            else
              atomic_symlink "$link_path" "$skill_dir"
              echo "creating claude skill symlink: $link_path → $skill_dir"
            fi
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
