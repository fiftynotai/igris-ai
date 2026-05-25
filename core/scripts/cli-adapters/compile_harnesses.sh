#!/bin/bash

# Description: Orchestrate harness regeneration. Reads harness-manifest.json
#              and, for each agent/target, emits the matching per-harness
#              projection: claude/gemini → atomic symlink to the registry-
#              resident harness.md (FR-152 α-assembly); codex → TOML via the
#              refactored sync_codex_agents.sh (frontmatter + body separated,
#              FR-151 sidecar). See L-519 §18.1 (compile/drift-verify pairing).
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
# emit_skill_symlink <harness_label> <link_path> <skill_dir>
#
# FR-153 D1: per-symlink emit shared across the 3 skills/symlink compile
# branches (claude/codex/gemini). Encodes the SAME 3-case dispatch the FR-149
# claude branch did, parameterized by <harness_label> for log strings:
#   - regular file at link_path → echo ERROR + return 1 (refuse-to-clobber)
#   - existing symlink resolving to skill_dir → silent no-op (idempotent)
#   - existing symlink with different target → atomic repoint + migration log
#   - nothing there → create + log
# Caller owns rc + SUMMARY bookkeeping. See L-519 §18.1.
# ---------------------------------------------------------------------------
emit_skill_symlink() {
  local harness_label="$1"
  local link_path="$2"
  local skill_dir="$3"
  if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
    echo "[$harness_label/skills/$(basename "$link_path")] ERROR — refuse to clobber non-symlink at $link_path (remove manually if it should be a registry-anchored symlink)" >&2
    return 1
  fi
  if [ -L "$link_path" ]; then
    local current
    current=$(readlink "$link_path" 2>/dev/null || true)
    if [ "$current" = "$skill_dir" ]; then
      return 0  # already correctly anchored — silent no-op
    fi
    atomic_symlink "$link_path" "$skill_dir"
    echo "migrating legacy $harness_label skill symlink: $link_path → $skill_dir (was: $current)"
    return 0
  fi
  atomic_symlink "$link_path" "$skill_dir"
  echo "creating $harness_label skill symlink: $link_path → $skill_dir"
  return 0
}

# ---------------------------------------------------------------------------
# assemble_agent_harness_into_registry <name> <canon_abs> <exc_abs> <out_dir>
#
# FR-152 α-assembly (compile-side fallback). Materializes
# `<out_dir>/harness.md` = `---\n<frontmatter>\n---\n\n<body>` so claude/gemini
# symlinks resolve to ONE registry-resident file. Frontmatter resolution
# preference:
#   1. `<out_dir>/frontmatter.md` (FR-151 vendor-side sidecar — personal agent),
#   2. `<dirname canon_abs>/frontmatter.md` (FR-151 in-place sidecar),
#   3. inline frontmatter extracted from `canon_abs` (TD-195 fallback — core
#      agents whose split hasn't landed).
# Body is `strip_frontmatter "$canon_abs"`. When `<exc_abs>` is non-empty
# the FR-144 / TD-193 body-exception is applied at the unique anchor line.
# Atomic temp + mv. Idempotent — same inputs → same bytes. See L-519, FR-151.
# ---------------------------------------------------------------------------
assemble_agent_harness_into_registry() {
  local name="$1"
  local canon_abs="$2"
  local exc_abs="$3"
  local out_dir="$4"

  mkdir -p "$out_dir"

  # Resolve frontmatter.md per the preference order above. Note the on-disk
  # sidecar shape is `---\n<fields>\n---\n` (FR-151 contract); we strip the
  # surrounding delimiters here so the assembled harness.md doesn't double-wrap.
  local fm_text=""
  if [ -f "$out_dir/frontmatter.md" ]; then
    fm_text=$(parse_frontmatter "$out_dir/frontmatter.md" || cat "$out_dir/frontmatter.md")
  elif [ -f "$(dirname "$canon_abs")/frontmatter.md" ]; then
    fm_text=$(parse_frontmatter "$(dirname "$canon_abs")/frontmatter.md" \
              || cat "$(dirname "$canon_abs")/frontmatter.md")
  else
    # TD-195 fallback: extract inline frontmatter from canonical. Falls back to
    # an empty fields block when there's no inline frontmatter either (matches
    # pre-FR-152 lenient codex behavior; the assembled harness.md will have an
    # empty `---\n---\n` block, which is harmless).
    fm_text=$(parse_frontmatter "$canon_abs" || echo "")
  fi

  # Strip a trailing newline from frontmatter; we add our own delimiters.
  fm_text="${fm_text%$'\n'}"

  local body
  body=$(strip_frontmatter "$canon_abs")

  # Atomic assemble: build text via python3 so anchor-application + the
  # `---\n<fm>\n---\n\n<body>` concatenation matches the TS vendor path
  # byte-for-byte (FR-144/TD-193 regression guard).
  local out_path="$out_dir/harness.md"
  local tmp="$out_path.tmp-$$"
  python3 - "$tmp" "$fm_text" "$body" "$exc_abs" <<'PY'
import json
import sys

out_path = sys.argv[1]
fm = sys.argv[2]
body = sys.argv[3]
exc_path = sys.argv[4]

if exc_path:
    with open(exc_path, "r", encoding="utf-8") as fh:
        exc = json.load(fh)
    anchor = exc["anchor"].strip()
    insert_lines = exc["insert"]
    body_lines = body.splitlines()
    matches = [i for i, ln in enumerate(body_lines) if ln.strip() == anchor]
    if len(matches) != 1:
        sys.stderr.write(
            f"Error: body-exception anchor matched {len(matches)} lines "
            "(expected exactly 1) in canonical body\n"
        )
        sys.exit(1)
    idx = matches[0]
    body_lines = body_lines[: idx + 1] + insert_lines + body_lines[idx + 1 :]
    body = "\n".join(body_lines)
    if not body.endswith("\n"):
        body += "\n"

text = "---\n" + fm + "\n---\n\n" + body
if not text.endswith("\n"):
    text += "\n"
with open(out_path, "w", encoding="utf-8") as fh:
    fh.write(text)
PY
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$tmp"
    return $rc
  fi
  mv "$tmp" "$out_path"
}

# ---------------------------------------------------------------------------
# resolve_or_extract_frontmatter <name> <canon_abs>
#
# FR-152: emit the absolute path of a file containing the agent's YAML
# frontmatter (newline-separated, NO `---` delimiters) so the refactored
# `sync_codex_agents.sh` can read it. Preference order mirrors
# `assemble_agent_harness_into_registry`:
#   1. `<dirname canon_abs>/frontmatter.md` (FR-151 in-place sidecar),
#   2. `$BRAIN_DIR/registry/agents/<name>/frontmatter.md` (vendor-side sidecar),
#   3. extract inline from `canon_abs` via parse_frontmatter, write to a
#      tempfile (TD-195 fallback for core agents). Tempfile path is appended
#      to TMPFILES_TO_CLEAN for trap cleanup.
# Echoes the resolved path. Returns non-zero when no frontmatter exists.
# ---------------------------------------------------------------------------
resolve_or_extract_frontmatter() {
  local name="$1"
  local canon_abs="$2"

  local in_place="$(dirname "$canon_abs")/frontmatter.md"
  if [ -f "$in_place" ]; then
    echo "$in_place"
    return 0
  fi
  local in_vendor="$BRAIN_DIR/registry/agents/$name/frontmatter.md"
  if [ -f "$in_vendor" ]; then
    echo "$in_vendor"
    return 0
  fi
  # TD-195 fallback: extract inline. BSD mktemp on macOS only treats the LAST
  # contiguous `X`s before EOF as the template, so the pattern has no `.md`
  # suffix; the file content is identical to a `frontmatter.md` sidecar shape
  # which is what `get_skill_field` reads (no extension dependency).
  # FR-152 D4: this preserves the pre-FR-152 lenient codex behavior for canonicals
  # that have neither a sidecar nor inline frontmatter. The wrapped tempfile is
  # an empty frontmatter block; `get_skill_field` returns "" for any field,
  # mirroring the pre-FR-152 emit (empty description / name-from-basename).
  local tmp wrapped inline_text
  tmp="$(mktemp "${TMPDIR:-/tmp}/igris_codex_fm_inline.XXXXXX")"
  if parse_frontmatter "$canon_abs" > "$tmp"; then
    inline_text="$(cat "$tmp")"
  else
    inline_text=""
  fi
  rm -f "$tmp"
  # Wrap in `---\n...\n---\n` so `get_skill_field` (which expects delimiters)
  # reads it. Same shape as a real frontmatter.md sidecar regardless of whether
  # the inline extract succeeded — empty block is fine downstream.
  wrapped="$(mktemp "${TMPDIR:-/tmp}/igris_codex_fm_wrapped.XXXXXX")"
  {
    echo "---"
    if [ -n "$inline_text" ]; then
      printf '%s\n' "$inline_text"
    fi
    echo "---"
  } > "$wrapped"
  # Register for cleanup via the loop trap.
  TMPFILES_TO_CLEAN+=("$wrapped")
  echo "$wrapped"
}

# ---------------------------------------------------------------------------
# compile_md_agent_target <harness_label> <name> <canon_abs> <exc_abs>
#                         <target_abs>
#
# FR-152 unified α-projection for claude + gemini agent targets. Both harnesses
# share the SAME registry-resident derived file (`harness.md`); only the log
# strings differ. The 3-case dispatch:
#
#   Case A — target absent → assemble harness.md + create symlink → it.
#   Case B — target IS a symlink → if it resolves to the registry harness.md,
#            silent no-op; else atomically repoint + log migration.
#   Case C — target IS a regular file → HARD ERROR (refuse-to-clobber). The
#            FR-149 Case C back-compat path is RETIRED by FR-152 (along with
#            the legacy body-refresh adapter, retired by FR-152). Operator
#            must rm + re-run compile.
#
# See L-519 (the symlink IS the projection, anchored at the registry-resident
# harness.md). Body-exception is applied at assembly time, not symlink time.
# ---------------------------------------------------------------------------
compile_md_agent_target() {
  local harness_label="$1"
  local name="$2"
  local canon_abs="$3"
  local exc_abs="$4"
  local target_abs="$5"

  local registry_agent_dir="$BRAIN_DIR/registry/agents/$name"
  if ! assemble_agent_harness_into_registry "$name" "$canon_abs" "$exc_abs" \
                                            "$registry_agent_dir"; then
    return 1
  fi
  local harness_target="$registry_agent_dir/harness.md"

  # Case C: real file, NOT a symlink → refuse-to-clobber. The FR-149 back-compat
  # via the legacy body-refresh adapter is retired by FR-152; the operator
  # must remove the file manually before compile re-creates a registry-anchored
  # symlink.
  if [ -f "$target_abs" ] && [ ! -L "$target_abs" ]; then
    echo "[$name/$harness_label] ERROR — refuse to clobber non-symlink target: $target_abs (remove manually if it should be a registry-anchored symlink)" >&2
    return 1
  fi

  # Case B: existing symlink — re-anchor or no-op.
  if [ -L "$target_abs" ]; then
    local current_target
    current_target=$(readlink "$target_abs" 2>/dev/null || true)
    local resolved
    resolved=$(realpath "$target_abs" 2>/dev/null || true)
    local expected_real
    expected_real=$(realpath "$harness_target" 2>/dev/null || echo "$harness_target")
    if [ -n "$resolved" ] && [ "$resolved" = "$expected_real" ]; then
      return 0  # already correctly anchored — silent no-op
    fi
    mkdir -p "$(dirname "$target_abs")"
    atomic_symlink "$target_abs" "$harness_target"
    echo "migrating legacy $harness_label symlink: $target_abs → $harness_target (was: $current_target)"
    return 0
  fi

  # Case A: nothing there — create.
  if [ ! -e "$target_abs" ]; then
    mkdir -p "$(dirname "$target_abs")"
    atomic_symlink "$target_abs" "$harness_target"
    echo "creating $harness_label symlink: $target_abs → $harness_target"
    return 0
  fi

  # Anything else (e.g. directory) — refuse to clobber.
  echo "[$name/$harness_label] ERROR — refuse to clobber non-symlink, non-file target: $target_abs" >&2
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

# FR-152: arm the unified EXIT trap BEFORE allocating any tempfile so a mid-
# script `exit 1` (e.g. a merge_overlay_manifest failure) still cleans up the
# literal `XXXXXX.json` file BSD mktemp on macOS creates when the X's aren't at
# end-of-template. Both TMP_MERGED and TMPFILES_TO_CLEAN are union'd in the
# handler.
TMP_MERGED=""
TMPFILES_TO_CLEAN=()
_cleanup_tmpfiles() {
  # Force return 0 even when nothing needs cleanup. Under `set -e` a trailing
  # `&&`-chain that fails would propagate as the trap's exit status and
  # rewrite the script's exit code (a clean success would become 1). Tested
  # by harness_schema.test.bash's "compile resolves... by default" test.
  if [ "${#TMPFILES_TO_CLEAN[@]}" -gt 0 ]; then
    rm -f "${TMPFILES_TO_CLEAN[@]}"
  fi
  if [ -n "$TMP_MERGED" ]; then
    rm -f "$TMP_MERGED"
  fi
  return 0
}
trap '_cleanup_tmpfiles' EXIT

# Merge base + optional personal overlay (FR-136 base+overlay seam; FR-139
# registry seam). A name collision between an overlay (personal) agent and a
# base (core) agent is a HARD ERROR. The merged manifest is written to a temp
# file that the python3 flatten step below reads.
MERGED_MANIFEST="$MANIFEST"
if [ -n "$OVERLAY" ]; then
  # FR-152: BSD mktemp on macOS only treats the LAST contiguous X's before EOF
  # as a template; the .json suffix made the original FR-136 template a literal
  # filename that leaked across runs when the cleanup trap was bypassed (a
  # mid-script `exit` from a downstream failure). Drop the suffix — the file
  # content is JSON regardless of name.
  TMP_MERGED="$(mktemp "${TMPDIR:-/tmp}/igris-harness-merged.XXXXXX")"
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
# FR-152: TMPFILES_TO_CLEAN was initialized above the merge step; the EXIT trap
# already references it (loop-pushed inline tempfiles get cleaned on exit).

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

  # FR-154: agent target.path resolution mirrors the skills 3-case resolver
  # (compile_harnesses.sh:763 / check_harness_drift.sh parity). `~/...` expands
  # against $HOME, `/abs/...` is honored verbatim, anything else is taken as
  # project-relative. Drift sibling carries the identical block.
  case "$target_path" in
    "~"/*) target_abs="$HOME/${target_path#"~/"}" ;;
    /*)    target_abs="$target_path" ;;
    *)     target_abs="$PROJECT_ROOT/$target_path" ;;
  esac

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
      # FR-152: registry-anchored symlink → assembled harness.md (Case A/B);
      # real-file target → refuse-to-clobber (Case C retired). See L-519.
      compile_md_agent_target "claude" "$name" "$canon_abs" "$exc_abs" \
                              "$target_abs" || rc=$?
      ;;
    gemini)
      # FR-152: first-class gemini agent target. SAME α-projection as claude —
      # both symlinks resolve to the same registry harness.md.
      compile_md_agent_target "gemini" "$name" "$canon_abs" "$exc_abs" \
                              "$target_abs" || rc=$?
      ;;
    codex)
      # FR-152: refactored sync_codex_agents.sh consumes the FR-151 frontmatter
      # sidecar separately from the body. The resolver provides one (in-place,
      # vendor, or extracted-inline tempfile via TD-195 fallback).
      fm_abs=""
      if fm_abs=$(resolve_or_extract_frontmatter "$name" "$canon_abs"); then
        bash "$ADAPTER_DIR/sync_codex_agents.sh" "$fm_abs" "$canon_abs" \
                                                 "$target_abs" "$name" || rc=$?
      else
        rc=1
      fi
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
        claude/symlink)
          # FR-149/FR-153: per-skill registry-anchored symlinks (claude). For
          # each <name>/SKILL.md under the source root, emit a symlink at
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
            if ! emit_skill_symlink "claude" "$link_path" "$skill_dir"; then
              SUMMARY+=("FAIL  skills/$s_type/$skill_name — refuse to clobber non-symlink at $link_path")
              rc=1
              continue
            fi
          done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                     -name 'SKILL.md' -print0 | sort -z)
          ;;
        codex/symlink)
          # FR-153: per-skill registry-anchored symlinks (codex). Mirror shape
          # of claude/symlink, with one extra guard: codex resolves relative-
          # path symlinks from cwd (POSIX-incorrect — D2). Hard-fail when
          # skill_dir is not absolute. See L-519.
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
            # FR-153 D2: codex absolute-path enforcement.
            case "$skill_dir" in
              /*) : ;;
              *)
                echo "[$s_type/skills/$skill_name] ERROR — codex symlink requires absolute target (got relative: $skill_dir). The 'source' field must be absolute, '~'-prefixed, or relative-resolved (compile_harnesses.sh source-resolution should have absolutized this)." >&2
                SUMMARY+=("FAIL  skills/$s_type/$skill_name — codex symlink target not absolute: $skill_dir")
                rc=1
                continue
                ;;
            esac
            if ! emit_skill_symlink "codex" "$link_path" "$skill_dir"; then
              SUMMARY+=("FAIL  skills/$s_type/$skill_name — refuse to clobber non-symlink at $link_path")
              rc=1
              continue
            fi
          done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                     -name 'SKILL.md' -print0 | sort -z)
          ;;
        gemini/symlink)
          # FR-153: per-skill registry-anchored symlinks (gemini). Exact mirror
          # of claude/symlink (no codex absolute-path guard). See L-519.
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
            if ! emit_skill_symlink "gemini" "$link_path" "$skill_dir"; then
              SUMMARY+=("FAIL  skills/$s_type/$skill_name — refuse to clobber non-symlink at $link_path")
              rc=1
              continue
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
