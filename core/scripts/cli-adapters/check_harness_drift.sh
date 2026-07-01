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
#                           <brain>/loadout/harness-manifest.personal.json.
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
# project per-skill loadout-anchored symlinks. The verdict is by target-path
# realpath against the loadout-vendored skill dir (L-515 containment), NOT a
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
# OPTIONAL personal overlay (FR-139 seam) under <brain>/loadout/.
BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
readonly DEFAULT_OVERLAY="$BRAIN_DIR/loadout/harness-manifest.personal.json"

# FR-212a: how the SKILLS DELEGATE drift arm invokes the TS delegate
# (`igris loadout project-skills`, run idempotently as the present/absent
# re-check). Resolution mirrors compile_harnesses.sh exactly: $IGRIS_CLI (a
# full command string — the bats seam) word-split into an ARRAY, else the
# `igris` binary on PATH.
IGRIS_CLI_CMD=()
if [ -n "${IGRIS_CLI:-}" ]; then
  read -ra IGRIS_CLI_CMD <<< "$IGRIS_CLI"
else
  IGRIS_CLI_CMD=(igris)
fi

# FR-212d Phase 2: the SKILLS engine is now ALWAYS "delegate" — read IDENTICALLY
# to compile_harnesses.sh (L-519 §18.1: the compile pass and its drift sibling
# MUST agree). The custom symlink-realpath drift body was DELETED; `verify_skills`
# is the tool's idempotent re-check only. No escape hatch (the `IGRIS_SKILLS_ENGINE`
# env read is gone). Kept as a constant for the unconditional delegate drift arm.
igris_skills_engine() {
  echo "delegate"
}

# FR-212d Phase 2: the MCP engine is now ALWAYS "delegate" — so the grant-drift
# invariant below (assert the Igris-owned no-prompt grant is present per harness)
# ALWAYS runs. The custom merger placement for the delegated harnesses was
# DELETED; antigravity's ENTRY stays custom INSIDE the TS but its drift is still
# the shared per-entry shape check (engine-agnostic). No escape hatch.
igris_mcp_engine() {
  echo "delegate"
}

# ---------------------------------------------------------------------------
# usage — prints usage and exits with code 2.
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 --project-root <dir> [--manifest <path>] [--overlay <path>] [--filter <name-glob>] [--surface agents|skills|mcp|hook|all] [--expect-core]" >&2
  echo "" >&2
  echo "Fails (exit 1) if any harness file has drifted from its canonical prompt." >&2
  echo "--surface: restrict the drift check to ONE projection surface (default: all)." >&2
  echo "           Mirrors compile_harnesses.sh --surface; lets 'igris add's scoped" >&2
  echo "           verify re-check ONLY the surface it just projected (FR-180)." >&2
  echo "--expect-core: also fail LOUDLY if a declared core surface is skipped by the" >&2
  echo "               ownership gate or 0 targets match (FR-180/TD-235)." >&2
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
# FR-180 cross-phase: restrict the drift check to ONE projection surface
# (agents|skills|mcp|hook), mirroring compile_harnesses.sh --surface.
# Default `all` preserves the whole-project drift-guard posture (CI / `harness
# check`). `igris add`'s scoped verify passes the surface it just projected so a
# pre-existing UNRELATED drift in another surface cannot false-fail a clean add.
SURFACE_KIND="all"
# FR-180 (TD-235 / D5): mirror of compile's --expect-core. When set, a declared
# core surface skipped by the ownership gate (or a 0-target run) is a LOUD FAIL
# instead of a silent / merely-visible skip. §18.1 deliver+drift pairing: the
# drift side carries the same loud-vs-silent distinction as the compile side.
EXPECT_CORE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-root)
      PROJECT_ROOT="${2:-}"
      shift 2 || usage
      ;;
    --expect-core)
      EXPECT_CORE=1
      shift
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

PROJECT_ROOT="$( cd "$PROJECT_ROOT" && pwd )"

# FR-202 (M0): validate --surface from the surface registry (IGRIS_SURFACE_IDS
# in _common.sh) — the SAME membership-gate enforcement point compile uses, so
# the accepted set lives in ONE place. Byte-identical error message to the
# former hard-coded gate (mirrors compile_harnesses.sh).
if ! igris_surface_is_valid "$SURFACE_KIND"; then
  echo "Error: --surface must be ${IGRIS_SURFACE_IDS// /, }, or all (got '$SURFACE_KIND')" >&2
  usage
fi

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

# FR-212d Phase 2: `resolve_skill_link_path` was DELETED here — its only caller
# was the custom verify_skills symlink body, now retired (skills drift is the
# `skills` CLI idempotent re-check). The compile sibling's copy was deleted too.

# ---------------------------------------------------------------------------
# verify_md_agent_symlink_drift <name> <harness_label> <target_abs>
#
# FR-152 / FR-158 / FR-159 / FR-171 / TD-208 per-harness drift verdict for
# claude + codex + gemini + opencode AGENT targets. Each harness has its own
# loadout-resident expected file
# (`<BRAIN_DIR>/loadout/agents/<name>/harness.<label>.<ext>`, where ext = `md`
# for claude/gemini/opencode and `toml` for codex) — the assembly happens at
# compile time. The verdict primitive is PER-HARNESS:
#
#   claude   → symbolic-link verdict (readlink/realpath flow); see below.
#   codex    → symbolic-link verdict (FR-159: codex shares claude's primitive;
#              expected file is harness.codex.toml).
#   opencode → symbolic-link verdict (FR-171: OpenCode's agent loader follows
#              symlinks, verified live; shares claude's primitive; expected
#              file is harness.opencode.md).
#   gemini   → hard-link verdict (inode equality); delegates to
#              verify_gemini_agent_hardlink_drift.
#
# Common precondition: MISSING when target absent (no -L, no -e).
#
# Claude / Codex branch verdicts (FR-152 / FR-159):
#   DRIFTED — target is a regular file (refuse-to-clobber posture).
#   DRIFTED — symlink resolves outside the loadout (legacy reference-mode).
#   DRIFTED — symlink resolves inside the loadout but to the wrong file.
#   DRIFTED — symlink is broken.
#   MATCH   — symlink resolves to the expected harness.<label>.<ext>.
#
# Pairs line-for-line with `compile_md_agent_target` in compile_harnesses.sh.
# Updates MATCH/DRIFT counters (caller-scoped). Both sides realpath'd for the
# macOS `/var` → `/private/var` prefix. See L-515, L-519 §18.1, FR-158, FR-159,
# TD-208.
# ---------------------------------------------------------------------------
verify_md_agent_symlink_drift() {
  local name="$1"
  local harness_label="$2"
  local target_abs="$3"

  # FR-159: codex's expected loadout file is harness.codex.toml (TOML, not
  # Markdown). Claude/gemini stay on .md. The rest of the function is
  # extension-agnostic — the symlink/realpath compare cares only about
  # paths, not file contents.
  local harness_ext="md"
  if [ "$harness_label" = "codex" ]; then
    harness_ext="toml"
  fi
  local expected_target="$BRAIN_DIR/loadout/agents/$name/harness.${harness_label}.${harness_ext}"

  # Common precondition: MISSING when target absent (no -L, no -e). Applies
  # to both claude and gemini branches.
  if [ ! -e "$target_abs" ] && [ ! -L "$target_abs" ]; then
    echo "  [$name/$harness_label] MISSING — harness target absent: $target_abs"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  if [ "$harness_label" = "gemini" ]; then
    verify_gemini_agent_hardlink_drift "$name" "$target_abs" "$expected_target"
    return $?
  fi

  # claude branch — symlink/realpath flow.
  if [ ! -L "$target_abs" ]; then
    # Regular file (or other non-symlink shape) → refuse-to-clobber DRIFTED.
    echo "  [$name/$harness_label] DRIFTED"
    echo "      target    : $target_abs"
    echo "      reason    : non-symlink target — remove manually if it should be a loadout-anchored symlink (FR-152 retired the body-refresh back-compat)"
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

  local loadout_real expected_real
  loadout_real=$(realpath "$BRAIN_DIR/loadout" 2>/dev/null || echo "$BRAIN_DIR/loadout")
  expected_real=$(realpath "$expected_target" 2>/dev/null || echo "$expected_target")

  case "$resolved" in
    "$loadout_real"/*|"$loadout_real")
      if [ "$resolved" = "$expected_real" ]; then
        echo "  [$name/$harness_label] MATCH"
        echo "      expected  : $expected_target"
        echo "      symlink target: $target_abs → $resolved [loadout-anchored]"
        MATCH=$((MATCH + 1))
      else
        echo "  [$name/$harness_label] DRIFTED"
        echo "      expected  : $expected_target"
        echo "      symlink target: $target_abs → $resolved [loadout-anchored but mismatched]"
        echo "      reason    : $harness_label symlink loadout-anchored but points at the wrong file (got: $resolved, expected: $expected_real)"
        DRIFT=$((DRIFT + 1))
      fi
      ;;
    *)
      echo "  [$name/$harness_label] DRIFTED"
      echo "      expected  : $expected_target"
      echo "      symlink target: $target_abs → $resolved"
      echo "      reason    : $harness_label symlink target not loadout-anchored (legacy reference-mode state — run \`igris harness compile\` to migrate)"
      DRIFT=$((DRIFT + 1))
      ;;
  esac
}

# ---------------------------------------------------------------------------
# verify_gemini_agent_hardlink_drift <name> <target_abs> <expected_target>
#
# TD-208 hard-link drift verdict for the Gemini agent target. The target is a
# HARD LINK to <expected_target> — inode equality is the primary MATCH signal.
# The Gemini subagent loader does NOT follow symbolic links (verified live
# 2026-06-01) but DOES follow hard links; the loadout-canonical (L-516)
# invariant is preserved because hard link = same inode = same bytes-on-disk
# = loadout remains the single physical home.
#
# Verdict ordering (L-28 precondition discipline mirrors verify_mirror.sh):
#   1. expected_target MISSING in loadout → DRIFTED (compile never ran).
#   2. target is a symbolic link → DRIFTED (legacy pre-TD-208 emit; recompile
#      migrates to hard link).
#   3. inode(target) == inode(expected_target) AND nlink(expected_target) >= 2
#      → MATCH (correctly hard-linked).
#   4. inode mismatch BUT byte-content equal (md5) → DRIFT-WARN. Operator
#      manually `cp`-replaced the hard link; content is fine but the primitive
#      contract is broken (L-516 violated — there are now TWO bytes-on-disk
#      copies, not one). DRIFT-WARN counts as drift (exit 1).
#   5. inode mismatch AND byte-content differs → DRIFTED (target diverged
#      from loadout; recompile re-establishes).
#
# Note: BSD `stat -f` and macOS `md5 -q` are darwin-only flags. TD-096 mirror
# is darwin-only per current ops; Linux portability is a future brief if
# needed (gate via `case "$(uname -s)" in Darwin) ...; *) ...; esac`).
# ---------------------------------------------------------------------------
verify_gemini_agent_hardlink_drift() {
  local name="$1"
  local target_abs="$2"
  local expected_target="$3"

  if [ ! -f "$expected_target" ]; then
    echo "  [$name/gemini] DRIFTED"
    echo "      target    : $target_abs"
    echo "      expected  : $expected_target [absent in loadout]"
    echo "      reason    : loadout harness.gemini.md missing — run \`igris harness compile\` to assemble + hard-link"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  if [ -L "$target_abs" ]; then
    echo "  [$name/gemini] DRIFTED"
    echo "      target    : $target_abs [symbolic link — legacy pre-TD-208 emit]"
    echo "      expected  : $expected_target [hard link]"
    echo "      reason    : gemini target is a symlink (Gemini loader does not follow symlinks) — run \`igris harness compile\` to migrate to hard link"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  local tgt_inode src_inode src_nlink
  tgt_inode=$(stat -f %i "$target_abs" 2>/dev/null || echo "")
  src_inode=$(stat -f %i "$expected_target" 2>/dev/null || echo "")
  src_nlink=$(stat -f %l "$expected_target" 2>/dev/null || echo "0")

  if [ -n "$tgt_inode" ] && [ "$tgt_inode" = "$src_inode" ]; then
    # Defensive nlink check: a same-inode hit on a single-link file should be
    # impossible, but surface it if the OS reports inconsistently.
    if [ "$src_nlink" -lt 2 ]; then
      echo "  [$name/gemini] DRIFTED"
      echo "      target    : $target_abs [inode $tgt_inode, nlink=$src_nlink]"
      echo "      expected  : $expected_target [nlink should be >= 2]"
      echo "      reason    : inode equality but nlink=$src_nlink (defensive — filesystem reporting inconsistency)"
      DRIFT=$((DRIFT + 1))
      return 0
    fi
    echo "  [$name/gemini] MATCH"
    echo "      target    : $target_abs [hard link, inode $tgt_inode, nlink $src_nlink]"
    echo "      loadout  : $expected_target"
    MATCH=$((MATCH + 1))
    return 0
  fi

  # Inode mismatch — fall through to content-equality check for the
  # DRIFT-WARN case (operator replaced the hard link with a `cp` copy).
  local tgt_md5 src_md5
  tgt_md5=$(md5 -q "$target_abs" 2>/dev/null || echo "")
  src_md5=$(md5 -q "$expected_target" 2>/dev/null || echo "")
  if [ -n "$tgt_md5" ] && [ "$tgt_md5" = "$src_md5" ]; then
    echo "  [$name/gemini] DRIFT-WARN"
    echo "      target    : $target_abs [inode $tgt_inode, real-file copy]"
    echo "      expected  : $expected_target [inode $src_inode, hard-link source]"
    echo "      reason    : target content matches loadout but the file is a real-file copy, not a hard link (operator manually \`cp\`-replaced, or CLI bug) — content fine, primitive wrong; run \`igris harness compile\` to re-establish the hard link"
    # DRIFT-WARN counts as drift in the summary (exit 1) — content equality
    # is a soft signal but the primitive contract is broken (L-516 violated).
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  # Inode mismatch AND content differs — hard drift.
  echo "  [$name/gemini] DRIFTED"
  echo "      target    : $target_abs [inode $tgt_inode, content differs]"
  echo "      expected  : $expected_target [inode $src_inode]"
  echo "      reason    : gemini target diverged from loadout (different bytes AND different inode) — run \`igris harness compile\` to re-establish"
  DRIFT=$((DRIFT + 1))
  return 0
}

# ---------------------------------------------------------------------------
# verify_agent_schema_loadable <harness> <name> <file>
#
# TD-230: static (no-launch) target-harness SCHEMA-LOADABILITY dispatcher. A
# present + drift-clean harness file can still be REFUSED by the target
# harness's loader (GAP-2 / TD-229: an unknown key like `memory`, an invalid
# tool name, or an `mcp__` token — the DRIFT gate is blind to this because the
# file matches the projected bytes; the bytes THEMSELVES are unloadable). This
# dispatcher case-switches on <harness> and delegates to the per-harness pure
# validator. An unrecognized harness (one without a strict subagent schema) is
# a no-op (return 0, no accumulator touched). Extensible: add a `case` arm + a
# verify_<harness>_agent_schema_loadable fn for the next strict-schema harness.
# ---------------------------------------------------------------------------
verify_agent_schema_loadable() {
  local harness="$1"
  local name="$2"
  local file="$3"
  case "$harness" in
    gemini) verify_gemini_agent_schema_loadable "$name" "$file" ;;
    *) return 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# verify_gemini_agent_schema_loadable <name> <file>
#
# TD-230: pure (no harness launch) static schema-loadability check for a
# projected Gemini agent frontmatter. Mirrors READ-ONLY the compile-side
# contract that PRODUCES a loadable file — the §18.1 drift twin of
# compile_harnesses.sh's gemini α-assembly (TOOL_MAP + DROPS + the mcp__ filter,
# ~lines 264-351) and loadout.ts's CLAUDE_TO_GEMINI_TOOLS. It does NOT vendor a
# gemini-cli bundle; it re-expresses the same conservative contract Igris
# projects. Three static checks against the parsed frontmatter:
#   (a) ALLOWED KEYS ONLY = {name, description, tools, kind}. Any other key
#       (memory / model / temperature / max_turns / arbitrary) → SCHEMA-INVALID
#       (mirrors Gemini's "Unrecognized key(s) in object": 'memory').
#   (b) VALID TOOL NAMES: every tools[] token ∈ GEMINI_BUILTIN_TOOLS (the
#       VALUES of CLAUDE_TO_GEMINI_TOOLS). A Claude-shape token (Read/Edit/…) or
#       any unlisted name → SCHEMA-INVALID (mirrors Gemini's "Invalid tool name").
#   (c) NO mcp__ GRAMMAR: any tools[] token starting with `mcp__` →
#       SCHEMA-INVALID (Gemini rejects the double-underscore Claude shape).
#
# §18.1 SYNC (3-WAY constant): GEMINI_BUILTIN_TOOLS below MUST stay byte-in-sync
# with compile_harnesses.sh's TOOL_MAP values / DROPS set and loadout.ts's
# CLAUDE_TO_GEMINI_TOOLS. The no-false-positive bats test fails loudly if this
# allow-list rejects a legitimately-projected tool. Operator override via
# `frontmatter.gemini.md` is the escape hatch; the allow-list can widen toward
# the full gemini ALL_BUILTIN_TOOL_NAMES in a follow-up if a real builtin is
# needed.
#
# Reuses parse_simple_frontmatter_fields / parse_tools_field (byte-identical to
# compile_harnesses.sh's python). Increments SCHEMA_INVALID (orthogonal — NEVER
# touches MATCH/TOTAL/DRIFT, same discipline as the PARITY accumulator). The
# python rc is captured so it NEVER throws under set -e; exit 3 = schema-invalid
# (reason lines on stdout), 0 = OK, any other rc = internal error (ignored, no
# false positive — the drift verdict already fired for the file).
# ---------------------------------------------------------------------------
verify_gemini_agent_schema_loadable() {
  local name="$1"
  local file="$2"

  # Extract the raw frontmatter block (parse_frontmatter returns 1 + emits
  # nothing when the file has none — an empty block parses to zero fields = OK).
  local fm_text
  fm_text=$(parse_frontmatter "$file" 2>/dev/null || true)

  local reasons schema_rc=0
  reasons=$(python3 - "$fm_text" <<'PY'
import re
import sys

# GEMINI_BUILTIN_TOOLS — the VALUES of loadout.ts CLAUDE_TO_GEMINI_TOOLS (== the
# compile_harnesses.sh TOOL_MAP values). §18.1 3-way sync: keep byte-in-sync
# with compile_harnesses.sh TOOL_MAP/DROPS and loadout.ts CLAUDE_TO_GEMINI_TOOLS.
GEMINI_BUILTIN_TOOLS = {
    "read_file", "write_file", "replace", "run_shell_command",
    "grep_search", "list_directory", "task", "web_fetch", "web_search",
}
# Allowed top-level keys for a projected Gemini agent frontmatter. Anything else
# (memory/model/temperature/max_turns/arbitrary) is an Unrecognized key. Mirrors
# the DROPS set + the {name,description,tools,kind} shape compile emits.
ALLOWED_KEYS = {"name", "description", "tools", "kind"}


def parse_tools_field(value):
    """Mirror of compile_harnesses.sh parse_tools_field / TS parseToolsField."""
    trimmed = value.strip()
    if trimmed == "":
        return []
    inner = trimmed
    if inner.startswith("[") and inner.endswith("]"):
        inner = inner[1:-1]
    out = []
    for t in inner.split(","):
        t = t.strip()
        if (t.startswith('"') and t.endswith('"')) or (
            t.startswith("'") and t.endswith("'")
        ):
            t = t[1:-1]
        if t:
            out.append(t)
    return out


def parse_simple_frontmatter_fields(fields):
    """Mirror of compile_harnesses.sh parse_simple_frontmatter_fields."""
    out = []
    pattern = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$")
    for raw in fields.split("\n"):
        line = raw.rstrip("\r")
        if line.strip() == "":
            continue
        m = pattern.match(line)
        if not m:
            continue
        out.append({"key": m.group(1), "value": m.group(2)})
    return out


parsed = parse_simple_frontmatter_fields(sys.argv[1])
reasons = []

# (a) unrecognized keys (in first-seen order).
bad_keys = [e["key"] for e in parsed if e["key"] not in ALLOWED_KEYS]
if bad_keys:
    reasons.append("unrecognized key(s): " + ", ".join(bad_keys))

# (b)/(c) tool-token grammar.
for e in parsed:
    if e["key"] != "tools":
        continue
    for tok in parse_tools_field(e["value"]):
        if tok.startswith("mcp__"):
            reasons.append("mcp__ token not valid in gemini tools[]: " + tok)
        elif tok not in GEMINI_BUILTIN_TOOLS:
            reasons.append("invalid tool name: " + tok)

if reasons:
    for r in reasons:
        sys.stdout.write(r + "\n")
    sys.exit(3)
sys.exit(0)
PY
) || schema_rc=$?

  if [ "$schema_rc" -eq 3 ]; then
    echo "  [$name/gemini] SCHEMA-INVALID"
    echo "      target    : $file"
    while IFS= read -r reason; do
      [ -z "$reason" ] && continue
      echo "      reason    : $reason"
    done <<< "$reasons"
    echo "      fix       : run \`igris harness compile\` to re-project; operator override via frontmatter.gemini.md"
    SCHEMA_INVALID=$((SCHEMA_INVALID + 1))
  fi
  return 0
}

# ---------------------------------------------------------------------------
# verify_mcp_entry_drift <name> <harness> <config_path> <map_key>
#                        <canonical_json> <enabled> <secrets_path>
#
# FR-164 (FR-160 epic): per-(mcp,harness) MCP drift verdict, line-paired with
# the compile MCP pass (§18.1). Reads the on-disk harness config entry via
# `extract_mcp_entry`, derives the EXPECTED native shape via `normalize_mcp_shape`
# (the SAME helper that defines what compile writes), and structurally compares.
#
# FR-212d NOTE: this per-entry check re-derives the expected shape via the CUSTOM
# `normalize_mcp_shape` (⇄ TS `buildHarnessMcpEntry`), so it is only valid for
# CUSTOM-written entries. Today every MCP block is custom-shaped — the brain is
# the only server, and it is written by the in-process custom merger
# (init/install/doctor) OR by add-mcp into a custom-equivalent shape; only a
# future personal-MCP placed via a non-custom `add-mcp` path would differ and
# need its own expected-shape derivation here.
#
# Verdicts (single per row, via the any_* idiom inside the python compare):
#   MISSING — config file absent OR the entry absent (extract rc 10). DRIFT++.
#   DRIFTED — config UNPARSEABLE (extract rc 11); reason "unparseable". DRIFT++.
#   DRIFTED — entry present but diverges; reason names the differing KEY(s),
#             NEVER a value. DRIFT++.
#   MATCH   — entry deep-equals the expected shape. MATCH++.
#
# SECRET HYGIENE: for the codex env values, the expected shape carries the
# ${VAR} REFERENCE (normalize_mcp_shape's stand-in). This function re-resolves
# each codex ${VAR} from secrets.env and compares the RESOLVED LITERAL against
# the on-disk literal INSIDE the python compare — it prints only "env.<KEY>
# differs", NEVER the literal (resolved or on-disk). claude/gemini/opencode
# compare the reference directly (no secrets read). Updates MATCH/DRIFT
# (caller-scoped, same as the agent verdict fns). NEVER throws under set -e.
# ---------------------------------------------------------------------------
verify_mcp_entry_drift() {
  local name="$1"
  local harness="$2"
  local config_path="$3"
  local map_key="$4"
  local canonical_json="$5"
  local enabled="$6"
  local secrets_path="$7"

  # 1) Read the on-disk entry. rc 0 = present (JSON on stdout); 10 = MISSING;
  #    11 = unparseable. Capture rc without tripping set -e.
  local on_disk extract_rc=0
  on_disk=$(extract_mcp_entry "$config_path" "$map_key" "$name") || extract_rc=$?

  if [ "$extract_rc" -eq 10 ]; then
    echo "  [mcp/$name/$harness] MISSING"
    echo "      config    : $config_path"
    echo "      reason    : no '$name' entry under '$map_key' — run \`igris harness compile\` to project it"
    DRIFT=$((DRIFT + 1))
    return 0
  fi
  if [ "$extract_rc" -eq 11 ]; then
    echo "  [mcp/$name/$harness] DRIFTED"
    echo "      config    : $config_path"
    echo "      reason    : config unparseable — compile refuses to write; fix the file manually, then run \`igris harness compile\`"
    DRIFT=$((DRIFT + 1))
    return 0
  fi
  if [ "$extract_rc" -ne 0 ]; then
    # Any other rc is an internal extract error — treat as DRIFTED, never crash.
    echo "  [mcp/$name/$harness] DRIFTED"
    echo "      config    : $config_path"
    echo "      reason    : could not read the entry (extract rc $extract_rc)"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  # 2) Expected shape via the SHARED helper (reference stand-in for env values).
  local expected
  expected=$(normalize_mcp_shape "$canonical_json" "$harness" "$enabled")

  # 3) Structural compare. The python compare re-resolves codex ${VAR} from
  #    secrets.env (never printing a literal) and emits a verdict line:
  #      MATCH                  → entry deep-equals expected.
  #      DRIFTED:<keys>         → diverges; <keys> is a comma-joined KEY list
  #                               (top-level + env.<K>), NEVER any value.
  #      MISSING_SECRET:<VAR>   → codex ${VAR} absent from secrets.env (cannot
  #                               compute the expected literal) → drift.
  local cmp_verdict
  cmp_verdict=$(python3 - "$on_disk" "$expected" "$harness" "$secrets_path" <<'PY'
import json
import re
import sys

on_disk = json.loads(sys.argv[1])
expected = json.loads(sys.argv[2])
harness = sys.argv[3]
secrets_path = sys.argv[4]

VAR_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def load_secrets(path):
    # Mirror secrets.ts:parseSecretsEnv — never throw, absent → {}.
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return out
    for line in raw.split("\n"):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("export "):
            s = s[len("export "):].lstrip()
        eq = s.find("=")
        if eq <= 0:
            continue
        key = s[:eq].strip()
        if not key:
            continue
        val = s[eq + 1:]
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        out[key] = val
    return out


# For codex, swap the expected env REFERENCE for the resolved LITERAL so the
# compare matches what compile actually wrote. A missing secret → cannot
# compute the expected → report MISSING_SECRET (drift) WITHOUT printing a value.
env_key = "environment" if harness == "opencode" else "env"
missing_secret = None
if harness == "codex":
    secrets = load_secrets(secrets_path)
    exp_env = expected.get("env", {}) or {}
    resolved_env = {}
    for k, v in exp_env.items():
        m = VAR_RE.match(v) if isinstance(v, str) else None
        if m is not None:
            var = m.group(1)
            if var in secrets:
                resolved_env[k] = secrets[var]
            else:
                missing_secret = var
                break
        else:
            resolved_env[k] = v
    if missing_secret is not None:
        sys.stdout.write(f"MISSING_SECRET:{missing_secret}")
        sys.exit(0)
    expected["env"] = resolved_env

# Collect the differing KEY names (never values). Top-level keys first, then
# per-env-key diffs as env.<K>.
diff_keys = []

exp_top = {k: expected.get(k) for k in expected if k != env_key}
od_top = {k: on_disk.get(k) for k in on_disk if k != env_key}
for k in sorted(set(list(exp_top.keys()) + list(od_top.keys()))):
    if exp_top.get(k) != od_top.get(k):
        diff_keys.append(k)

exp_env = expected.get(env_key, {}) or {}
od_env = on_disk.get(env_key, {}) or {}
if not isinstance(od_env, dict):
    diff_keys.append(env_key)
else:
    for k in sorted(set(list(exp_env.keys()) + list(od_env.keys()))):
        if exp_env.get(k) != od_env.get(k):
            diff_keys.append(f"{env_key}.{k}")

if diff_keys:
    sys.stdout.write("DRIFTED:" + ",".join(diff_keys))
else:
    sys.stdout.write("MATCH")
PY
)

  case "$cmp_verdict" in
    MATCH)
      echo "  [mcp/$name/$harness] MATCH"
      echo "      config    : $config_path"
      MATCH=$((MATCH + 1))
      ;;
    MISSING_SECRET:*)
      local var="${cmp_verdict#MISSING_SECRET:}"
      echo "  [mcp/$name/$harness] DRIFTED"
      echo "      config    : $config_path"
      echo "      reason    : codex secret for \${$var} is not set in secrets.env — cannot verify the projected literal; add it, then run \`igris harness compile\`"
      DRIFT=$((DRIFT + 1))
      ;;
    DRIFTED:*)
      local keys="${cmp_verdict#DRIFTED:}"
      echo "  [mcp/$name/$harness] DRIFTED"
      echo "      config    : $config_path"
      echo "      reason    : entry diverges from the projected shape; differing key(s): $keys — run \`igris harness compile\` to re-project (no values shown)"
      DRIFT=$((DRIFT + 1))
      ;;
    *)
      echo "  [mcp/$name/$harness] DRIFTED"
      echo "      config    : $config_path"
      echo "      reason    : internal compare error"
      DRIFT=$((DRIFT + 1))
      ;;
  esac
  return 0
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
    # resolution can be keyed on it (core -> in-repo, personal -> loadout).
    # Defaults to non-empty "core", so no `-` sentinel / tab-collapse risk.
    layer = agent.get("layer", "") or "core"
    # FR-155: propagate `scope` as the FINAL columns (mirrors compile_harnesses.sh).
    # Appended AFTER `layer` so any IFS=$'\t' read with the pre-FR-155 column
    # list still gets the right values up through `layer`. Absent → global
    # (default per schema). `-` is the empty-paths sentinel (preserves column
    # count when paths is empty / scope is global).
    scope = agent.get("scope") or {}
    scope_type = scope.get("type") or "global"
    scope_paths_list = scope.get("paths") or []
    scope_paths_csv = ",".join(scope_paths_list) if scope_paths_list else "-"
    for target in agent.get("targets", []):
        print("\t".join([
            name, versioned, canon_dir, canon_ref, body_exc,
            target["type"], target["path"], layer, scope_type, scope_paths_csv,
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
# FR-217 M4: parity-guard violations (a descriptor-declared participating harness
# MISSING from an existing surface block's targets[] — the TD-228 class the
# per-target drift loop is blind to). Additive: does NOT touch TOTAL/MATCH/DRIFT;
# contributes to the non-zero exit independently.
PARITY=0
# TD-230: schema-invalid targets (present + drift-clean but the target harness's
# loader REFUSES the bytes — GAP-2 / TD-229). Additive: does NOT touch
# TOTAL/MATCH/DRIFT; contributes to the non-zero exit independently. Mirrors the
# PARITY accumulator design exactly.
SCHEMA_INVALID=0
# FR-156: per-agent tree-hash verdict is fired ONCE per agent (the loop walks
# per-target rows, so a 3-target agent would otherwise emit 3 tree verdicts).
# Tracked as a colon-delimited string `:name1:name2:` so the membership check
# `case "$TREE_CHECKED" in *":$name:"*)` works under bash 3.2 (macOS default
# — no associative arrays).
TREE_CHECKED=":"
# FR-212d Phase 2: SKILL_TREE_CHECKED (the per-skill-NAME tree-hash dedup) was
# removed with the custom verify_skills body — skills drift is now the `skills`
# CLI idempotent re-check, which has no per-skill tree pre-check to dedup.

echo "Harness drift check (project root: $PROJECT_ROOT):"
echo ""

# ---------------------------------------------------------------------------
# verify_agents — the agents drift-verification surface plugin (FR-202 M0).
# The per-agent tree-hash + per-target symlink/hardlink-realpath MATCH/DRIFTED/
# MISSING verdict logic is moved VERBATIM from the former inline agents drift
# pass; the outer `if SURFACE_KIND = agents|all` gate is now the registry
# dispatch loop (this fn runs only for the agents/all selection). The
# `[ -n "$WORK_ROWS" ]` guard stays here. Reads the top-level-computed WORK_ROWS
# and the shared global accumulators (TOTAL/MATCH/DRIFT/TREE_CHECKED).
# ---------------------------------------------------------------------------
verify_agents() {
if [ -n "$WORK_ROWS" ]; then
while IFS=$'\t' read -r name versioned canon_dir canon_ref body_exc ttype target_path layer scope_type scope_paths; do
  [ -z "$name" ] && continue

  # FR-155: project-scope filter. Mirrors compile_harnesses.sh — a
  # `scope.type=project` row is silently skipped (no verdict, no TOTAL++)
  # when the current --project-root realpath is not in scope.paths[]. Both
  # sides realpath'd (macOS `/tmp` ↔ `/private/tmp` equality). A project-
  # scoped entry that does not apply to the current root is NOT drift; it
  # is correctly filtered. MUST run BEFORE TOTAL=$((TOTAL+1)) so summary
  # counts align with the compile-side filter.
  if [ "$scope_type" = "project" ]; then
    project_root_real="$(realpath "$PROJECT_ROOT" 2>/dev/null || echo "$PROJECT_ROOT")"
    matched=0
    if [ -n "$scope_paths" ] && [ "$scope_paths" != "-" ]; then
      IFS=',' read -ra scope_paths_arr <<< "$scope_paths"
      for sp in "${scope_paths_arr[@]}"; do
        [ -z "$sp" ] && continue
        case "$sp" in
          "~"/*) sp_abs="$HOME/${sp#"~/"}" ;;
          /*)    sp_abs="$sp" ;;
          *)     sp_abs="$PROJECT_ROOT/$sp" ;;
        esac
        sp_real="$(realpath "$sp_abs" 2>/dev/null || echo "$sp_abs")"
        if [ "$sp_real" = "$project_root_real" ]; then
          matched=1
          break
        fi
      done
    fi
    if [ "$matched" -eq 0 ]; then
      continue
    fi
  fi
  TOTAL=$((TOTAL + 1))

  # Resolve canonical. An absolute or `~`-prefixed canon_dir is used verbatim
  # (FR-142 copy-vendor points canonical.dir at the vendored copy under
  # ~/.igris/loadout/<name>/); a relative dir is project-relative. Mirrors the
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
  # agent's sidecar lives in the runtime loadout (Layer-2,
  # <brain>/loadout/body-exceptions/, honoring IGRIS_BRAIN_DIR); a core
  # agent's sidecar lives in-repo alongside the adapter (Layer-1, unchanged).
  # Keying on layer (rather than try-loadout-then-repo) keeps provenance
  # one-directional: a re-introduced repo sidecar can never serve a personal
  # agent — closing the L-498 leak this brief addresses.
  exc_abs=""
  if [ -n "$body_exc" ] && [ "$body_exc" != "-" ]; then
    if [ "$layer" = "personal" ]; then
      exc_abs="$BRAIN_DIR/loadout/body-exceptions/$body_exc.json"
    else
      exc_abs="$ADAPTER_DIR/body-exceptions/$body_exc.json"
    fi
    if [ ! -f "$exc_abs" ]; then
      echo "  [$name/$ttype] MISSING — body-exception sidecar absent: $exc_abs"
      DRIFT=$((DRIFT + 1))
      continue
    fi
  fi

  # FR-156: TREE pre-check. ONE verdict per agent (deduped via TREE_CHECKED)
  # comparing the vendored loadout tree against the recorded path-origin's
  # source tree. Runs BEFORE the per-target FR-152 symlink check (plan
  # step 11) — the two verdicts are ORTHOGONAL (tree-match doesn't imply
  # symlink-correct, and vice versa) so both must fire so the summary count
  # is honest. Github origins are release-tag-tracked (not source-tree-
  # tracked) so we skip them with a note. The verdict diff sub-line caps at
  # N=5 differing relpaths with `(... and N more)` suffix (architect's
  # Decision 2 — single MATCH/DRIFTED + diff sub-line).
  tree_already_checked=0
  case "$TREE_CHECKED" in
    *":$name:"*) tree_already_checked=1 ;;
  esac
  if [ "$layer" = "personal" ] && [ "$tree_already_checked" -eq 0 ]; then
    TREE_CHECKED="${TREE_CHECKED}${name}:"
    tree_origins_path="$BRAIN_DIR/loadout/origins.json"
    tree_origin_info=""
    if [ -f "$tree_origins_path" ]; then
      tree_origin_info=$(python3 - "$tree_origins_path" "$name" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        origins = json.load(fh)
except OSError:
    sys.exit(0)
o = origins.get("agent:" + sys.argv[2])
if not isinstance(o, dict):
    sys.exit(0)
otype = o.get("type", "")
# tab-separated: type \t dir (path) | repo@ref (github)
if otype == "path":
    print(otype + "\t" + (o.get("dir") or ""))
elif otype == "github":
    print(otype + "\t" + (o.get("repo") or "") + "@" + (o.get("ref") or ""))
PY
)
    fi
    if [ -z "$tree_origin_info" ]; then
      : # no origin recorded for this personal agent — skip the tree pre-check
        # silently. The per-target FR-152 verdict still fires below; absence
        # of an origin is a recoverable state (operator never ran update on a
        # legacy entry — TD-191 zero-migration posture).
    else
      tree_origin_type="${tree_origin_info%%	*}"
      tree_origin_payload="${tree_origin_info#*	}"
      if [ "$tree_origin_type" = "path" ]; then
        tree_origin_dir="$tree_origin_payload"
        # Resolve `~/...` for sources recorded with a tilde prefix.
        case "$tree_origin_dir" in
          "~"/*) tree_origin_dir="$HOME/${tree_origin_dir#"~/"}" ;;
        esac
        tree_loadout_dir="$BRAIN_DIR/loadout/agents/$name"
        if [ ! -d "$tree_loadout_dir" ]; then
          echo "  [$name/tree] DRIFTED — loadout dir absent: $tree_loadout_dir"
          DRIFT=$((DRIFT + 1))
        elif [ ! -d "$tree_origin_dir" ]; then
          echo "  [$name/tree] NOTE — source dir gone ($tree_origin_dir); tree drift undetectable, per-target verify continues"
        else
          tree_expected=$(hash_agent_tree "$tree_loadout_dir")
          tree_actual=$(hash_agent_tree "$tree_origin_dir")
          if [ "$tree_expected" = "$tree_actual" ]; then
            echo "  [$name/tree] MATCH"
            MATCH=$((MATCH + 1))
          else
            echo "  [$name/tree] DRIFTED"
            echo "      loadout  : $tree_loadout_dir (sha $tree_expected)"
            echo "      source    : $tree_origin_dir (sha $tree_actual)"
            # Locate up to N=5 differing relpaths so the operator can act
            # without re-deriving the diff manually. Skip-list MUST stay byte-
            # for-byte in sync with TS isAgentTreeSkipped and bash
            # hash_agent_tree (TD-202: REGISTRY-NOTICE.md added).
            tree_diff=$(python3 - "$tree_loadout_dir" "$tree_origin_dir" <<'PY'
import hashlib
import os
import sys

EXACT = {"MAINTAINING.md", ".DS_Store", "node_modules", ".venv", "__pycache__", "REGISTRY-NOTICE.md"}


def skipped(name):
    if name in EXACT:
        return True
    if name.startswith(".git"):
        return True
    if name.endswith(".pyc"):
        return True
    return False


def walk(tree):
    out = {}
    if not os.path.isdir(tree):
        return out
    for root, dirs, files in os.walk(tree):
        dirs[:] = [d for d in dirs if not skipped(d)]
        for f in files:
            if skipped(f):
                continue
            abs_p = os.path.join(root, f)
            rel = os.path.relpath(abs_p, tree).replace(os.sep, "/")
            # FR-158 / FR-159: per-harness α-assembly outputs are derived;
            # exclude `harness.claude.md`, `harness.gemini.md`, AND
            # `harness.codex.toml` from the tree-diff basis (top-level
            # only — a nested file by either name would be legitimate
            # operator content).
            if rel in ("harness.claude.md", "harness.gemini.md", "harness.codex.toml", "harness.opencode.md"):
                continue
            try:
                with open(abs_p, "rb") as fh:
                    out[rel] = hashlib.sha256(fh.read()).hexdigest()
            except OSError:
                out[rel] = "<unreadable>"
    return out


a = walk(sys.argv[1])  # loadout
b = walk(sys.argv[2])  # source
diffs = []
keys = sorted(set(a) | set(b))
for k in keys:
    if k not in a:
        diffs.append("+ " + k + " (only in source)")
    elif k not in b:
        diffs.append("- " + k + " (only in loadout)")
    elif a[k] != b[k]:
        diffs.append("~ " + k + " (contents differ)")
N = 5
for d in diffs[:N]:
    print("      " + d)
if len(diffs) > N:
    print("      (... and {} more)".format(len(diffs) - N))
PY
)
            if [ -n "$tree_diff" ]; then
              printf '%s\n' "$tree_diff"
            fi
            echo "      reason    : agent tree diverges from recorded path-origin source — \`igris loadout update $name\` re-vendors"
            DRIFT=$((DRIFT + 1))
          fi
        fi
      elif [ "$tree_origin_type" = "github" ]; then
        echo "  [$name/tree] NOTE — github origin ($tree_origin_payload); freshness is release-tag tracked, tree-hash drift not applicable"
      fi
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

  # FR-152 / FR-158 / FR-159 / FR-171: claude + codex + gemini + opencode AGENT
  # verdicts are by target-path realpath against the per-harness
  # loadout-resident assembled file (`harness.claude.md`, `harness.codex.toml`,
  # `harness.gemini.md`, `harness.opencode.md` respectively — NOT body sha).
  # Pair line-for-line with `compile_md_agent_target` (L-519 §18.1
  # compile/drift-verify pairing). opencode follows symlinks (verified live) so
  # it shares the claude symlink-verdict branch (harness_ext=md). Both sides of
  # the containment check are realpath'd so macOS `/var` → `/private/var` (and
  # similar symlink-resolved TMPDIR prefixes) do not produce false
  # "not loadout-anchored" verdicts.
  if [ "$ttype" = "claude" ] || [ "$ttype" = "gemini" ] || [ "$ttype" = "codex" ] || [ "$ttype" = "opencode" ]; then
    verify_md_agent_symlink_drift "$name" "$ttype" "$target_abs"
    # TD-230: static schema-loadability check (GAP-2 / TD-229). A present +
    # drift-clean gemini target can still be REFUSED by Gemini's loader (unknown
    # `memory` key, invalid tool name, mcp__ token). Validate the ON-DISK
    # target_abs — the surface Gemini actually reads (on a MATCH it is the same
    # inode as the loadout source). Skip when absent (MISSING already emitted by
    # the drift verdict above). Additive verdict — never touches MATCH/TOTAL/DRIFT.
    if [ "$ttype" = "gemini" ] && [ -f "$target_abs" ]; then
      verify_agent_schema_loadable "gemini" "$name" "$target_abs"
    fi
    continue
  fi

  # No other agent target types are supported.
  echo "  [$name/$ttype] DRIFTED — unknown target type"
  DRIFT=$((DRIFT + 1))
done <<< "$WORK_ROWS"
fi
}

# ---------------------------------------------------------------------------
# verify_skills — the skills drift-verification surface plugin (FR-202 M0).
# Contains the FR-180 loud-vs-silent core-skip diagnostic, the SKILL_ROWS
# flatten, and the per-skill tree-hash + per-target drift verdict loop — all
# FR-212d Phase 2: the custom symlink/wrapper drift body + the TD-201 tree
# pre-check were deleted; verify_skills is now the `skills` CLI idempotent
# re-check. The outer `if SURFACE_KIND = skills|all` gates are the registry
# dispatch loop (this fn runs only for the skills/all selection). Reads/writes
# the shared global accumulators (TOTAL/MATCH/DRIFT/DELEGATED_SKILL_ROOTS).
# ---------------------------------------------------------------------------
verify_skills() {
# FR-212a: per-call dedup set for the SKILLS DELEGATE drift arm — the distinct
# source roots already re-checked this run (so the sibling target-type rows per
# source collapse to a single idempotent re-check). Reset each invocation.
# Unused on the custom path. `=()` is bash 3.2-safe; the iteration site uses the
# `${arr[@]+...}` empty-array guard required under `set -u`.
DELEGATED_SKILL_ROOTS=()

# ---------------------------------------------------------------------------
# FR-218 (mechanism B): §18.1 mirror of compile_harnesses.sh — IDENTICAL
# decision. Core is (re)projected IFF the project OWNS core OR the merged
# (base ++ overlay) manifest carries >=1 skill block that APPLIES to this
# --project-root (scope-matched — manifest_has_applicable_skill_block, the prune
# trigger). A scope-FILTERED-OUT / agent-only / no-personal non-owner drift run
# leaves the skills pass a NO-OP (no core re-check, no skills-CLI dependency, no
# real-$HOME touch). Computed ONCE; shared by the WARN diagnostic and the
# flatten. Drift re-derives the IDENTICAL source set the compile flatten produces
# — an asymmetric gate here would false-flag core skills (skills-surface-flatten-location).
# ---------------------------------------------------------------------------
_core_owned=0
core_surfaces_owned "$CORE_SURFACES" "$PROJECT_ROOT" && _core_owned=1
_merged_skill_applies=0
manifest_has_applicable_skill_block "$MERGED_MANIFEST" "$PROJECT_ROOT" && _merged_skill_applies=1
_include_core=0
if [ "$_core_owned" -eq 1 ] || [ "$_merged_skill_applies" -eq 1 ]; then
  _include_core=1
fi

# Loud, non-pruning WARN — fires ONLY when a NON-OWNER consumer drift run
# actually re-projects core to the global store (it carries an applicable
# personal skill — the prune trigger). Agent-only / scoped-out / no-personal
# non-owner runs stay silent no-ops.
if core_skills_declared "$CORE_SURFACES" \
   && [ "$_core_owned" -eq 0 ] \
   && [ "$_merged_skill_applies" -eq 1 ]; then
  echo "WARN  core skills are (re)projected to the GLOBAL user store from non-owner --project-root $PROJECT_ROOT (skills are global; no project-local skills dir; FR-218)" >&2
fi

# ---------------------------------------------------------------------------
# FR-137: skills-surface drift pass. For each skills target (unioned from the
# core surfaces-manifest.json and the merged agent manifest), re-derive the
# projected artifact to a temp file via the md_to_* compiler and compare
# against on-disk. The compiler IS the canonical-deriver. For the AGENTS.md
# compiler target the trailing date-stamped marker line is stripped from BOTH
# sides before sha so the verdict is date-stable.
# ---------------------------------------------------------------------------
SKILL_ROWS=$(python3 - "$CORE_SURFACES" "$MERGED_MANIFEST" "$_include_core" <<'PY'
import json
import sys

include_core = sys.argv[3] == "1"


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


# FR-218 (mechanism B): §18.1 mirror of compile_harnesses.sh — the core
# surfaces-manifest.json source is unioned IFF `include_core` (computed by the
# bash caller: project OWNS core OR the merged manifest carries >=1 skill block).
# When false (agent-only / no-personal drift) the skills pass is a no-op. Drift
# re-derives the IDENTICAL source set the compile flatten produces.
sources = ([sys.argv[1]] if include_core else []) + [sys.argv[2]]

# TD-191: NO `seen` dedup here. The drift pass mirrors compile_harnesses.sh
# (L-519 §18.1 compile/drift-verify pairing) — every (block, target) row
# that passes the merge's cross-block path-collision guard is legitimately
# distinct. A `seen` dedup would mask a legitimate multi-block target row.
for src in sources:
    for block in load_skills(src):
        if not isinstance(block, dict):
            continue
        source = block.get("source", "") or "-"
        # FR-155: per-block scope (absent → global; `-` is the empty-paths
        # sentinel). Mirrors compile_harnesses.sh skills-flatten.
        scope = block.get("scope") or {}
        scope_type = scope.get("type") or "global"
        scope_paths_list = scope.get("paths") or []
        scope_paths_csv = ",".join(scope_paths_list) if scope_paths_list else "-"
        # TD-201: per-block `layer` (gates the tree pre-check to personal
        # skills). Appended as the LAST column so existing pre-TD-201 IFS
        # reads stay back-compat. Default `core` so absent → no `-` sentinel
        # needed.
        layer = block.get("layer", "core") or "core"
        for t in block.get("targets", []) or []:
            print("\t".join([
                source,
                (t or {}).get("type", ""),
                (t or {}).get("method", ""),
                (t or {}).get("path", ""),
                scope_type,
                scope_paths_csv,
                layer,
            ]))
PY
)

if [ -n "$SKILL_ROWS" ]; then
  while IFS=$'\t' read -r s_source s_type s_method s_path s_scope_type s_scope_paths s_layer; do
    [ -z "$s_type" ] && continue
    # TD-201: legacy IFS-read default for the trailing `layer` column when an
    # older flatten elsewhere omits it (defensive — current flatten always
    # emits it). `core` is the schema default, matches FR-155 body_exception
    # precedent of falling back when the trailing column is missing.
    [ -z "$s_layer" ] && s_layer="core"

    # FR-155: skills surface project-scope filter (mirrors agent-loop filter
    # above and compile_harnesses.sh skills-loop filter). Silent skip when
    # scope.type=project and --project-root realpath not in scope.paths[];
    # gates TOTAL++ so summary count is filter-aware.
    if [ "$s_scope_type" = "project" ]; then
      project_root_real="$(realpath "$PROJECT_ROOT" 2>/dev/null || echo "$PROJECT_ROOT")"
      s_matched=0
      if [ -n "$s_scope_paths" ] && [ "$s_scope_paths" != "-" ]; then
        IFS=',' read -ra s_scope_paths_arr <<< "$s_scope_paths"
        for sp in "${s_scope_paths_arr[@]}"; do
          [ -z "$sp" ] && continue
          case "$sp" in
            "~"/*) sp_abs="$HOME/${sp#"~/"}" ;;
            /*)    sp_abs="$sp" ;;
            *)     sp_abs="$PROJECT_ROOT/$sp" ;;
          esac
          sp_real="$(realpath "$sp_abs" 2>/dev/null || echo "$sp_abs")"
          if [ "$sp_real" = "$project_root_real" ]; then
            s_matched=1
            break
          fi
        done
      fi
      if [ "$s_matched" -eq 0 ]; then
        continue
      fi
    fi

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

    # FR-212d Phase 2: SKILLS DELEGATE drift verdict (the ONLY skills-drift path
    # now — the custom symlink-realpath drift body + the TD-201 tree pre-check
    # were DELETED after the smoke gate went green). The `skills` CLI owns
    # placement (under ~/.agents/skills + ~/.claude/skills — NOT the manifest's
    # target paths), so the present/absent verdict is the tool's IDEMPOTENT
    # re-run: re-projecting an already-correct skill set is a clean no-op
    # (exit 0 → MATCH); a non-zero exit means the projection is missing or broken
    # (→ DRIFT). Dispatched ONCE per distinct source root (sibling target-type
    # rows collapse). Mirrors the compile delegate dispatch (L-519 §18.1). NO
    # custom fallback (constraint #2): a non-zero re-check is observable DRIFT.
    delegate_root="${src_abs:-$HOME/.igris/core/skills}"
    already_delegated=0
    # bash 3.2 + `set -u` empty-array guard (the first row hits an empty set).
    for _r in ${DELEGATED_SKILL_ROOTS[@]+"${DELEGATED_SKILL_ROOTS[@]}"}; do
      if [ "$_r" = "$delegate_root" ]; then already_delegated=1; break; fi
    done
    if [ "$already_delegated" -eq 1 ]; then
      # Sibling target-type row for an already-re-checked root: fold its TOTAL++
      # back so the count is one-per-root, matching the single re-check verdict.
      TOTAL=$((TOTAL - 1))
      continue
    fi
    DELEGATED_SKILL_ROOTS+=("$delegate_root")
    drc=0
    "${IGRIS_CLI_CMD[@]}" loadout project-skills \
      --source "$delegate_root" \
      --project-root "$PROJECT_ROOT" \
      ${OVERLAY:+--overlay "$OVERLAY"} >/dev/null 2>&1 || drc=$?
    if [ "$drc" -eq 0 ]; then
      MATCH=$((MATCH + 1))
    else
      echo "DRIFT skills (delegate) — re-check of $delegate_root failed (exit $drc); skills missing or broken" >&2
      DRIFT=$((DRIFT + 1))
    fi
    continue
  done <<< "$SKILL_ROWS"
fi
}


# ---------------------------------------------------------------------------
# verify_mcp — the MCP-server drift-verification surface plugin (FR-202 M0).
# FR-164 (FR-160 epic): line-paired with the compile MCP pass (§18.1). Flattens
# the SAME (mcp,target) rows via `flatten_mcp_rows` (target_kind="all" — drift
# checks all harness targets per block, consistent with drift's "check
# everything" posture). For each row it resolves the harness config path + map
# key and calls `verify_mcp_entry_drift` (which reads the on-disk entry, derives
# the expected shape via the SHARED normalize_mcp_shape, and compares —
# re-resolving codex literals inside the compare WITHOUT printing any value).
#
# Config-path resolution honors per-harness env overrides (test sandbox seam)
# then falls back to the native default ($HOME-anchored, matching paths.ts).
# secrets.env is resolved from <brain>/secrets.env (honored by the codex
# re-resolve) with an IGRIS_SECRETS_PATH override for tests.
#
# The secret-safe compare + MATCH/DRIFTED/MISSING verdict logic is moved
# VERBATIM; the outer `if SURFACE_KIND = mcp|all` gate is now the registry
# dispatch loop. The `[ -n "$MCP_DRIFT_ROWS" ]` guard stays here.
# ---------------------------------------------------------------------------
verify_mcp() {
MCP_DRIFT_ROWS=$(flatten_mcp_rows "$MERGED_MANIFEST" "$CORE_SURFACES" "all" "$PROJECT_ROOT")
if [ -n "$MCP_DRIFT_ROWS" ]; then
  mcp_secrets_path="${IGRIS_SECRETS_PATH:-$BRAIN_DIR/secrets.env}"
  while IFS=$'\t' read -r d_name d_canon d_type d_enabled d_scope_type d_scope_paths; do
    [ -z "$d_name" ] && continue
    [ -z "$d_type" ] && continue
    : "$d_scope_type" "$d_scope_paths"  # v1 global-only; carried, not filtered.

    # FR-180 (S1): honor --filter on the MCP drift surface (parity with the
    # compile MCP pass + the skills drift loop). `igris add mcp`'s verify half
    # passes --filter <name> so the drift check is SCOPED to the just-added MCP
    # server, not the whole project — a pre-existing UNRELATED MCP drift can't
    # false-fail a clean add. Default FILTER='*' checks every block. Gated
    # BEFORE TOTAL++ so the summary count stays filter-aware (compile parity).
    skill_name_matches_filter "$d_name" "$FILTER" || continue

    TOTAL=$((TOTAL + 1))

    # Resolve config path + map key per harness. Per-harness env overrides
    # (IGRIS_MCP_<HARNESS>_CONFIG) are the test-sandbox seam; defaults are the
    # native $HOME-anchored paths (byte-identical to paths.ts).
    case "$d_type" in
      claude)
        d_map_key="mcpServers"
        d_config="${IGRIS_MCP_CLAUDE_CONFIG:-$HOME/.claude.json}"
        ;;
      gemini)
        d_map_key="mcpServers"
        d_config="${IGRIS_MCP_GEMINI_CONFIG:-$HOME/.gemini/settings.json}"
        ;;
      antigravity)
        # FR-179 (R1): gemini map key (mcpServers) but a DISTINCT config file
        # ~/.gemini/config/mcp_config.json. IGRIS_MCP_ANTIGRAVITY_CONFIG is the
        # test-sandbox seam (mirrors the per-harness seams above).
        d_map_key="mcpServers"
        d_config="${IGRIS_MCP_ANTIGRAVITY_CONFIG:-$HOME/.gemini/config/mcp_config.json}"
        ;;
      opencode)
        d_map_key="mcp"
        d_config="${IGRIS_MCP_OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"
        ;;
      codex)
        d_map_key="mcp_servers"
        d_config="${IGRIS_MCP_CODEX_CONFIG:-$HOME/.codex/config.toml}"
        ;;
      *)
        echo "  [mcp/$d_name/$d_type] DRIFTED"
        echo "      reason    : unknown harness type '$d_type'"
        DRIFT=$((DRIFT + 1))
        continue
        ;;
    esac

    verify_mcp_entry_drift "$d_name" "$d_type" "$d_config" "$d_map_key" \
      "$d_canon" "$d_enabled" "$mcp_secrets_path"
  done <<< "$MCP_DRIFT_ROWS"
fi

# FR-212b: GRANT-DRIFT INVARIANT. Under IGRIS_MCP_ENGINE=delegate, Igris wrote a
# no-prompt trust GRANT for every harness (mcp-grant.ts) alongside the add-mcp
# server registration. That grant is a NEW projection artifact the per-entry
# drift loop above does NOT see (it checks the SERVER ENTRY in the mcpServers/
# mcp_servers config, not the permissions/trust surface). Assert the grant is
# PRESENT for every harness — a missing grant (any harness) is DRIFT. The grant
# predicate is the TS `verifyBrainGrant` exposed via `igris loadout
# verify-mcp-grant` (exit 0 = present, 1 = missing) — bash never re-implements the
# per-harness grant grammar (§18.1). opencode is `covered` (its grant lives in
# agent frontmatter) and the verb reports it present.
#
# FR-212d Phase 2: the engine is now ALWAYS delegate, so the grant invariant is
# GATED on whether the brain MCP is actually in scope (`$MCP_DRIFT_ROWS` non-empty
# — i.e. an mcp_servers block was flattened from the manifest/core surfaces). A
# project that declares NO MCP block (e.g. an agent-only personal manifest, or a
# project that does not own the core surfaces) has nothing to grant, so the
# invariant must not fire a phantom grant-DRIFT. The smoke gate + real installs
# declare the brain MCP, so the grant IS asserted there.
if [ -n "$MCP_DRIFT_ROWS" ]; then
  # FR-217: the grant-harness set is READ from the canonical descriptor
  # (harnesses with a `grant` block) instead of the hardcoded
  # `claude codex gemini opencode antigravity` loop. Declaration order is
  # preserved so the verdict output stays byte-identical.
  _grant_descriptor="$(resolve_harness_descriptor_path)"
  while IFS= read -r grant_harness; do
    [ -z "$grant_harness" ] && continue
    TOTAL=$((TOTAL + 1))
    grc=0
    "${IGRIS_CLI_CMD[@]}" loadout verify-mcp-grant \
      --harness "$grant_harness" \
      --project-root "$PROJECT_ROOT" >/dev/null 2>&1 || grc=$?
    if [ "$grc" -eq 0 ]; then
      MATCH=$((MATCH + 1))
    else
      echo "  [mcp-grant/$grant_harness] DRIFTED"
      echo "      reason    : no-prompt grant missing for $grant_harness (delegate engine)"
      DRIFT=$((DRIFT + 1))
    fi
  done < <(read_harness_descriptor "$_grant_descriptor" grant_harnesses)
fi

# TD-284: DESCRIPTOR↔npx AGENT-ID COVERAGE. Every descriptor `agent_id` (the npx
# agent id — the SAME set mcpAgentIds()/skillAgentIds() expose; claude→claude-code,
# gemini→gemini-cli) MUST be an agent that `add-mcp` (and, by the shared-authority
# argument below, `skills`) can register into — else the MCP registration + skills
# projection to that harness SILENTLY no-ops. One-directional SUBSET assertion: a
# descriptor agent-id MISSING from the tool = DRIFT (loud); a tool that supports
# MORE (e.g. claude-desktop/cline) is NOT drift (Igris is intentionally narrower —
# do NOT flag the extras).
#
# TARGET SOURCE OF TRUTH = the DESCRIPTOR, never `list-agents`. `list-agents` is
# only the PROBE of what the tool ACCEPTS; sourcing the checked set from it would
# over-broaden to non-harness agents (claude-desktop/cline/…). Do NOT "fix" this
# to iterate the tool's list — the descriptor `agent_ids` (read via
# read_harness_descriptor) are the target set.
#
# add-mcp is the SHARED authority for BOTH surfaces (mcp + skills): they consume
# the SAME descriptor `agent_ids` and (TD-284, empirically verified 2026-07-01)
# the `skills` valid-agent set also covers every Igris agent-id, but `skills` has
# NO clean `list-agents` command — so `add-mcp list-agents` (via `igris loadout
# list-mcp-agents`) is the one probe for both.
#
# GATED on $MCP_DRIFT_ROWS (brain MCP in scope) — mirrors the grant-drift gate
# above, so an agent-only / no-mcp drift run does not fire it. GRACEFUL
# DEGRADATION: if the probe verb is UNAVAILABLE (add-mcp not resolvable/runnable,
# or the CLI lacks the verb → non-zero exit / empty output), SKIP with a one-line
# stderr notice and DO NOT fail (never break `igris harness check` on a box
# without the npx tools).
#
# §18.1/§18.4 NOTE (drift-only BY DESIGN — no compile twin, and correctly so):
# compile does not PRODUCE the tool's supported-agent set (add-mcp does), so there
# is no projected artifact to pair with. §18.4 forbids a COMPILE branch without a
# drift branch, NOT a drift-only assertion — cf. the grant invariant above, also a
# check with no per-target compile pass. Adding a compile_harnesses.sh twin here
# would be meaningless (nothing to project).
if [ -n "$MCP_DRIFT_ROWS" ]; then
  _agentid_probe_rc=0
  _agentid_probe_out="$("${IGRIS_CLI_CMD[@]}" loadout list-mcp-agents 2>/dev/null)" || _agentid_probe_rc=$?
  # Keep only well-formed agent-id lines (defensive against any CLI banner noise).
  _agentid_supported="$(printf '%s\n' "$_agentid_probe_out" | grep -E '^[a-z][a-z0-9-]*$' || true)"
  if [ "$_agentid_probe_rc" -ne 0 ] || [ -z "$_agentid_supported" ]; then
    echo "  [mcp-agents] SKIP — add-mcp not runnable via the CLI probe (loadout list-mcp-agents rc=$_agentid_probe_rc); descriptor↔npx agent-id coverage NOT verified" >&2
  else
    _agentid_descriptor="$(resolve_harness_descriptor_path)"
    while IFS= read -r _aid; do
      [ -z "$_aid" ] && continue
      TOTAL=$((TOTAL + 1))
      if printf '%s\n' "$_agentid_supported" | grep -qxF "$_aid"; then
        # Silent MATCH (mirrors the grant invariant — loud only on drift).
        MATCH=$((MATCH + 1))
      else
        echo "  [mcp-agents/$_aid] DRIFTED"
        echo "      reason    : descriptor agent-id '$_aid' is NOT in add-mcp's supported-agent set (add-mcp list-agents) — MCP registration + skills projection to this harness will SILENTLY fail; add the agent upstream or correct the descriptor agent_id"
        DRIFT=$((DRIFT + 1))
      fi
    done < <(read_harness_descriptor "$_agentid_descriptor" agent_ids)
  fi
fi
}

# ---------------------------------------------------------------------------
# verify_hook — the event-hook drift-verification surface plugin (FR-202 M0).
# FR-180 (D7 - Option B): line-paired with the compile hook pass (§18.1
# compile/drift PAIRING — same flattened rows, not a shape parity). Flattens the
# SAME (hook,target) rows via flatten_hook_rows (target_kind="all" — drift checks
# both harness targets per block). Hook drift is PRESENCE-BASED, NOT a byte-shape
# comparison: for claude it reads the project's .claude/settings.json and asserts
# the hook command PATH is present under its event array (MATCH) or absent
# (MISSING) via verify_hook_entry_present — there is no bash hook-shaper twin
# (unlike the agent α-assemblers) because the hook is identified by its command
# path, not its full byte-shape. For opencode it asserts the FR-104
# plugin exists (covered → MATCH; absent → MISSING). Honors --filter (S1) so the
# scoped verify checks only the added hook.
#
# The presence-based MATCH/MISSING/DRIFTED verdict logic is moved VERBATIM; the
# outer `if SURFACE_KIND = hook|all` gate is now the registry dispatch loop. The
# `[ -n "$HOOK_DRIFT_ROWS" ]` guard stays here.
# ---------------------------------------------------------------------------
verify_hook() {
HOOK_DRIFT_ROWS=$(flatten_hook_rows "$MERGED_MANIFEST" "$CORE_SURFACES" "all" "$PROJECT_ROOT")
if [ -n "$HOOK_DRIFT_ROWS" ]; then
  while IFS=$'\t' read -r h_name h_event h_command h_matcher h_timeout h_type h_enabled h_layer h_scope_type h_scope_paths; do
    [ -z "$h_name" ] && continue
    [ -z "$h_type" ] && continue
    : "$h_matcher" "$h_timeout" "$h_enabled" "$h_layer" "$h_scope_type" "$h_scope_paths"

    skill_name_matches_filter "$h_name" "$FILTER" || continue

    TOTAL=$((TOTAL + 1))

    if [ "$h_type" = "opencode" ]; then
      plugin_path="$HOME/.config/opencode/plugins/igris-bridge.ts"
      if [ -f "$plugin_path" ]; then
        echo "  [hook/$h_name/opencode] MATCH (covered by the FR-104 plugin)"
        MATCH=$((MATCH + 1))
      else
        echo "  [hook/$h_name/opencode] MISSING"
        echo "      reason    : FR-104 plugin absent at $plugin_path (run \`igris install\`)"
        DRIFT=$((DRIFT + 1))
      fi
      continue
    fi

    if [ "$h_type" = "antigravity" ]; then
      # FR-181: presence-check the command path under the hook's event array in
      # ~/.gemini/config/hooks.json (gemini-cli hook format — same structure as
      # claude settings.json, so verify_hook_entry_present is file-agnostic).
      # IGRIS_HOOK_ANTIGRAVITY_CONFIG is the test-sandbox seam (mirrors the MCP
      # antigravity drift arm's IGRIS_MCP_ANTIGRAVITY_CONFIG).
      ag_hooks="${IGRIS_HOOK_ANTIGRAVITY_CONFIG:-$HOME/.gemini/config/hooks.json}"
      ag_verdict=$(verify_hook_entry_present "$ag_hooks" "$h_event" "$h_command")
      case "$ag_verdict" in
        MATCH)
          echo "  [hook/$h_name/antigravity] MATCH"
          MATCH=$((MATCH + 1))
          ;;
        MISSING)
          echo "  [hook/$h_name/antigravity] MISSING"
          echo "      reason    : no '$h_event' hook with command '$h_command' in $ag_hooks (run \`igris install\`)"
          DRIFT=$((DRIFT + 1))
          ;;
        *)
          echo "  [hook/$h_name/antigravity] DRIFTED"
          echo "      reason    : hooks.json unparseable or unexpected shape ($ag_hooks)"
          DRIFT=$((DRIFT + 1))
          ;;
      esac
      continue
    fi

    # claude: read .claude/settings.json + assert the command path is present.
    h_settings="${IGRIS_HOOK_CLAUDE_SETTINGS:-$PROJECT_ROOT/.claude/settings.json}"
    hook_verdict=$(verify_hook_entry_present "$h_settings" "$h_event" "$h_command")
    case "$hook_verdict" in
      MATCH)
        echo "  [hook/$h_name/claude] MATCH"
        MATCH=$((MATCH + 1))
        ;;
      MISSING)
        echo "  [hook/$h_name/claude] MISSING"
        echo "      reason    : no '$h_event' hook with command '$h_command' in $h_settings (run \`igris harness compile\`)"
        DRIFT=$((DRIFT + 1))
        ;;
      *)
        echo "  [hook/$h_name/claude] DRIFTED"
        echo "      reason    : settings.json unparseable or unexpected shape ($h_settings)"
        DRIFT=$((DRIFT + 1))
        ;;
    esac
  done <<< "$HOOK_DRIFT_ROWS"
fi
}

# ---------------------------------------------------------------------------
# FR-202 (M0): surface-agnostic dispatch — the crown-jewel mirror of compile's
# loop. Iterate the surface registry (IGRIS_SURFACE_IDS in _common.sh, in
# verification order) and run each surface's verify_<surface> plugin when the
# --surface selection includes it (or `all`). This SINGLE loop replaces the five
# former inline `if SURFACE_KIND = X` drift-gates — adding a surface is a
# registry entry + a verify_<surface> plugin, ZERO edit here. Plugins are called
# as PLAIN statements (never in a condition) so `set -e` stays active inside them
# exactly as in the former top-level passes. Accumulators (TOTAL/MATCH/DRIFT and
# the TREE_CHECKED dedup string + DELEGATED_SKILL_ROOTS) are global, shared across
# plugins (bash 3.2 has no namerefs). Verdict bytes are held INVARIANT — the
# Phase-0 byte-identical baseline is the acceptance oracle.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# verify_parity — FR-217 M4 parity guard (the TD-228 class). The per-target drift
# loops above only verify targets that ARE listed; a DROPPED target is invisible.
# Flag an agent that dropped an agent-target-ROW harness its SIBLINGS keep: the
# expected set is the manifest's collective ROW FOOTPRINT (the row-harnesses at
# least one applicable agent projects to, ∩ the descriptor's
# agents.projection=="target-row" set = {codex,gemini,opencode}), and an agent
# whose footprint is a STRICT non-empty subset is flagged PARITY (distinct from
# MATCH/DRIFTED/MISSING). claude is projection:symlink (exempt) and antigravity
# has no agents block (exempt) — neither is ever a candidate (OPEN DECISION #1).
# Using the manifest footprint (not the full descriptor set) means an intentional
# single/partial-row project (a codex-only or claude-only agent) is NOT a false
# positive — only an INCONSISTENT drop within a manifest is. Honors the same
# surface-selection, scope.type=project, and --filter gates as the agent drift.
#
# SCOPE — AGENTS + MCP + HOOK (TD-281 extended this beyond the FR-217 M4
# agents-only arm): each surface is parity-checked against the descriptor's
# PROJECTED set for that surface. Agents use `agents.projection == "target-row"`;
# mcp/hook use the TD-281 `mcp.projected` / `hooks.projected` flags. The projected
# flag is the "surface-projected vs carve-out" signal that distinguishes block
# PRESENCE (capability) from surface PROJECTION (expectation): every Igris
# harness has an mcp block but antigravity is mcp.projected:false (the FR-179
# carve-out: its entry is custom-
# written to ~/.gemini/config/, not add-mcp-projected), so the brain MCP surface
# block omitting antigravity is LEGITIMATE, not flagged. All three arms use the
# SAME footprint heuristic (a block/agent whose projected-target set is a STRICT
# non-empty subset of the manifest's collective footprint is flagged) so an
# intentionally partial/single block is never a false positive — see
# _verify_parity_surface. Each arm is gated by its own --surface selection.
# ---------------------------------------------------------------------------
# _verify_parity_surface <descriptor-path> <surface: mcp|hook>
#
# TD-281: the mcp/hook twin of the agents parity arm. Same FOOTPRINT heuristic as
# agents (NOT a naive "expect the full projected set", which would false-positive
# a legitimately partial/single block): EXPECTED = the manifest's collective
# surface FOOTPRINT (∪ of every block's targets ∩ the descriptor's surface-
# PROJECTED set), and a block whose projected-target set is a STRICT NON-EMPTY
# subset of the footprint is flagged PARITY. The projected set is the NEW per-
# surface flag (mcp.projected / hooks.projected); antigravity mcp.projected:false
# (FR-179) is excluded so the brain MCP block omitting it is NOT flagged (the
# byte-identical state). A block whose intersection with the projected set is
# empty (e.g. an antigravity-only mcp fixture) is never flagged. Blocks are
# sourced exactly like flatten_mcp_rows / flatten_hook_rows: the merged manifest
# always + the core surfaces-manifest.json only when --project-root OWNS it.
# Honors --filter on the block name (mirrors the mcp/hook drift loops). v1
# surfaces are global-only so — like verify_mcp/verify_hook — no scope.type
# filter is applied. UNQUOTED $(...) for the assignment (bash 3.2 heredoc-in-
# "$()" is a parse error — L-519 / FR-217 M2 trap).
# ---------------------------------------------------------------------------
_verify_parity_surface() {
  local descriptor="$1"
  local surface="$2"
  local parity_out parity_n
  parity_out=$(python3 - "$MERGED_MANIFEST" "$CORE_SURFACES" "$descriptor" "$FILTER" "$PROJECT_ROOT" "$surface" <<'PY'
import fnmatch
import json
import os
import sys

merged_path = sys.argv[1]
core_path = sys.argv[2]
descriptor_path = sys.argv[3]
flt = sys.argv[4] or "*"
project_root = sys.argv[5]
surface = sys.argv[6]  # "mcp" | "hook"

# surface -> (surfaces[] key, descriptor block key)
SKEY = "mcp_servers" if surface == "mcp" else "hooks"
DKEY = "mcp" if surface == "mcp" else "hooks"


def _read_harnesses(p):
    if not p:
        return {}
    try:
        h = json.load(open(p, encoding="utf-8")).get("harnesses")
        return h if isinstance(h, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


# Projected set = harnesses whose descriptor block carries `projected: true`.
# Precedence mirrors the agents arm: the resolved canonical descriptor, else the
# manifest's own harnesses block (igris-ai is self-describing).
harnesses = _read_harnesses(descriptor_path)
if not harnesses:
    try:
        mh = json.load(open(merged_path, encoding="utf-8")).get("harnesses")
        harnesses = mh if isinstance(mh, dict) else {}
    except Exception:  # noqa: BLE001
        harnesses = {}

projected = set()
for hk, hv in harnesses.items():
    if isinstance(hv, dict):
        blk = hv.get(DKEY)
        if isinstance(blk, dict) and blk.get("projected") is True:
            projected.add(hk)
if not projected:
    sys.exit(0)


def load_blocks(path):
    # LIST of surface blocks; legacy single-object normalized to [obj]; missing
    # -> []. Mirrors flatten_mcp_rows / flatten_hook_rows.
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    v = (data.get("surfaces") or {}).get(SKEY)
    if v is None:
        return []
    if isinstance(v, dict):
        return [v]
    if isinstance(v, list):
        return v
    return []


# Source the blocks exactly like the flatten helpers: the merged manifest always;
# the core surfaces-manifest.json only when --project-root OWNS it.
sources = [merged_path]
try:
    cs_real = os.path.realpath(core_path)
    pr_real = os.path.realpath(project_root)
    if os.path.commonpath([cs_real, pr_real]) == pr_real:
        sources.insert(0, core_path)
except (OSError, ValueError):
    pass

# Pass 1: per-block projected-target set + the collective footprint.
blocks = []  # (name, present_projected)
footprint = set()
for src in sources:
    for block in load_blocks(src):
        if not isinstance(block, dict):
            continue
        name = block.get("name")
        if not isinstance(name, str) or not name:
            continue
        if not fnmatch.fnmatch(name, flt):
            continue
        targets = block.get("targets")
        if not isinstance(targets, list) or len(targets) == 0:
            continue  # an absent surface is not a parity miss; only EXISTING blocks
        present = {t["type"] for t in targets
                   if isinstance(t, dict) and isinstance(t.get("type"), str)}
        proj = present & projected
        blocks.append((name, proj))
        footprint |= proj

# Pass 2: flag a block whose projected-target set is a STRICT, NON-EMPTY subset
# of the footprint (it projects to >=1 projected harness but dropped one a
# sibling keeps — the TD-228 shape on the mcp/hook surface). An empty
# intersection (no projected harness at all, e.g. an antigravity-only block) is
# never flagged.
for name, proj in blocks:
    if proj and proj < footprint:
        for missing in sorted(footprint - proj):
            print(f"  [{surface}/{name}/{missing}] PARITY")
            print(f"      reason    : projected harness '{missing}' missing from "
                  f"{SKEY}[] targets (siblings declare it)")
PY
)
  if [ -n "$parity_out" ]; then
    printf '%s\n' "$parity_out"
    parity_n="$(printf '%s\n' "$parity_out" | grep -c '] PARITY')"
    PARITY=$((PARITY + parity_n))
  fi
}

# ---------------------------------------------------------------------------
# verify_parity — runs the agents (FR-217 M4) + mcp/hook (TD-281) parity arms,
# each gated by its own --surface selection. The agents arm logic is UNCHANGED
# (the acceptance oracle); the mcp/hook arms delegate to _verify_parity_surface.
# ---------------------------------------------------------------------------
verify_parity() {
  local descriptor
  descriptor="$(resolve_harness_descriptor_path)"

  # --- agents arm (FR-217 M4 — unchanged logic, now gated per-arm) ---
  if igris_surface_selected "agents" "$SURFACE_KIND"; then
  local parity_out parity_n
  parity_out=$(python3 - "$MERGED_MANIFEST" "$descriptor" "$FILTER" "$PROJECT_ROOT" "$HOME" <<'PY'
import fnmatch
import json
import os
import sys

manifest_path = sys.argv[1]
descriptor_path = sys.argv[2]
flt = sys.argv[3] or "*"
project_root = sys.argv[4]
home = sys.argv[5]


def _read_harnesses(p):
    if not p:
        return {}
    try:
        h = json.load(open(p, encoding="utf-8")).get("harnesses")
        return h if isinstance(h, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


try:
    manifest = json.load(open(manifest_path, encoding="utf-8"))
except Exception:  # noqa: BLE001
    sys.exit(0)

harnesses = _read_harnesses(descriptor_path)
if not harnesses:
    mh = manifest.get("harnesses")
    harnesses = mh if isinstance(mh, dict) else {}

# row_harnesses = the descriptor's agent-target-ROW harnesses
# (agents.projection == "target-row" = {codex, gemini, opencode}). claude is
# projection:symlink (exempt) and antigravity has no agents block (exempt) —
# neither is ever a parity candidate (the OPEN-DECISION #1 boundary).
row_harnesses = set()
for hk, hv in harnesses.items():
    if isinstance(hv, dict):
        a = hv.get("agents")
        if isinstance(a, dict) and a.get("projection") == "target-row":
            row_harnesses.add(hk)
if not row_harnesses:
    sys.exit(0)


def scope_matches(scope):
    # Mirror the bash scope.type=project filter (realpath, ~/ + project-relative).
    if not isinstance(scope, dict):
        return True
    if scope.get("type") != "project":
        return True
    pr = os.path.realpath(project_root)
    for sp in scope.get("paths") or []:
        if not isinstance(sp, str):
            continue
        if sp.startswith("~/"):
            sp_abs = os.path.join(home, sp[2:])
        elif sp.startswith("/"):
            sp_abs = sp
        else:
            sp_abs = os.path.join(project_root, sp)
        if os.path.realpath(sp_abs) == pr:
            return True
    return False


agents = manifest.get("agents")
if not isinstance(agents, list):
    sys.exit(0)

# The TD-228 anomaly is an agent that DROPPED a row-harness its SIBLINGS keep. So
# the expected set is the manifest's own collective ROW FOOTPRINT (the row-
# harnesses at least one applicable agent projects to, intersected with the
# descriptor's row set), NOT the full descriptor set. This precisely catches
# "8 agents have {codex,gemini,opencode}, 1 dropped gemini" while NEVER false-
# positiving a project that intentionally uses a single/partial row set (a
# codex-only agent, a claude-only agent) — there is no sibling establishing the
# missing harness as expected. Pass 1 builds per-agent row sets + the footprint.
agent_rows = []  # (name, present_row_harnesses)
footprint = set()
for agent in agents:
    if not isinstance(agent, dict):
        continue
    name = agent.get("name")
    if not isinstance(name, str) or not fnmatch.fnmatch(name, flt):
        continue
    if not scope_matches(agent.get("scope")):
        continue
    targets = agent.get("targets")
    if not isinstance(targets, list) or len(targets) == 0:
        continue  # an absent surface is not a parity miss; only EXISTING blocks
    present = {t["type"] for t in targets if isinstance(t, dict) and isinstance(t.get("type"), str)}
    rows = present & row_harnesses
    agent_rows.append((name, rows))
    footprint |= rows

# Pass 2: flag an agent whose row footprint is a STRICT, NON-EMPTY subset of the
# manifest footprint (it projects to >=1 row-harness but dropped one a sibling
# keeps — the TD-228 shape).
for name, rows in agent_rows:
    if rows and rows < footprint:
        for missing in sorted(footprint - rows):
            print(f"  [{name}/{missing}] PARITY")
            print(f"      reason    : agent-row harness '{missing}' missing from targets[] (siblings declare it)")
PY
)
  if [ -n "$parity_out" ]; then
    printf '%s\n' "$parity_out"
    parity_n="$(printf '%s\n' "$parity_out" | grep -c '] PARITY')"
    PARITY=$((PARITY + parity_n))
  fi
  fi

  # --- mcp arm (TD-281) — gated on the mcp surface selection ---
  if igris_surface_selected "mcp" "$SURFACE_KIND"; then
    _verify_parity_surface "$descriptor" "mcp"
  fi

  # --- hook arm (TD-281) — gated on the hook surface selection ---
  if igris_surface_selected "hook" "$SURFACE_KIND"; then
    _verify_parity_surface "$descriptor" "hook"
  fi
}

for _surface in $IGRIS_SURFACE_IDS; do
  if igris_surface_selected "$_surface" "$SURFACE_KIND"; then
    "verify_$_surface"
  fi
done

# FR-217 M4: parity guard runs AFTER the per-target drift passes (additive — does
# not touch TOTAL/MATCH/DRIFT; increments PARITY only on a violation).
verify_parity

if [ "$TOTAL" -eq 0 ] && [ "$PARITY" -eq 0 ] && [ "$SCHEMA_INVALID" -eq 0 ]; then
  # FR-202 (M0): surface noun list derived from the registry
  # (IGRIS_SURFACE_LABELS) — now "No agent/skills/mcp/hook targets matched …"
  # (FR-202 M4 dropped the identity surface).
  echo "No $(igris_surface_empty_match_nouns) targets matched (filter='$FILTER')." >&2
  # FR-180 (TD-235 / D5): under --expect-core a 0-target drift run is the silent
  # no-op the brief forbids (the verify half of `igris add` got nothing to
  # check). Fail LOUDLY; without the flag the historical exit-0 is preserved.
  if [ "$EXPECT_CORE" -eq 1 ]; then
    echo "FAIL  core surfaces — 0 targets matched under --expect-core for --project-root $PROJECT_ROOT; run from the igris-ai repo or pass --core" >&2
    exit 1
  fi
  exit 0
fi

echo ""
echo "  ----"
echo "  $TOTAL targets — $MATCH in sync, $DRIFT drifted/missing"
# FR-217 M4: only surfaced when there is a violation, so a clean run stays
# byte-identical to the pre-parity output (the acceptance oracle).
if [ "$PARITY" -gt 0 ]; then
  echo "  $PARITY parity violation(s) — declared harness missing from an existing targets[]"
fi
# TD-230: only surfaced when there is a violation, so a clean run stays
# byte-identical to the pre-TD-230 output (the parseHarnessOutput acceptance
# oracle, row #89). Mirrors the PARITY conditional line exactly.
if [ "$SCHEMA_INVALID" -gt 0 ]; then
  echo "  $SCHEMA_INVALID schema-invalid target(s) — present + drift-clean but the target harness refuses to load them"
fi

if [ "$DRIFT" -gt 0 ] || [ "$PARITY" -gt 0 ] || [ "$SCHEMA_INVALID" -gt 0 ]; then
  exit 1
fi
exit 0
