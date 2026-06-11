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
  echo "Usage: $0 --project-root <dir> [--manifest <path>] [--overlay <path>] [--filter <name-glob>] [--surface agents|skills|mcp|identity|hook|all] [--expect-core]" >&2
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
# (agents|skills|mcp|identity), mirroring compile_harnesses.sh --surface.
# Default `all` preserves the whole-project drift-guard posture (CI / `harness
# check`). `igris add`'s scoped verify passes the surface it just projected so a
# pre-existing UNRELATED drift in another surface (e.g. the os_identity surface
# drifting under a brain-root project-root because {{IGRIS_VERSION}} can't
# resolve there) cannot false-fail a clean add.
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

# FR-180: validate --surface (mirrors compile_harnesses.sh's identical gate).
case "$SURFACE_KIND" in
  agents|skills|mcp|identity|hook|all) : ;;
  *)
    echo "Error: --surface must be agents, skills, mcp, identity, hook, or all (got '$SURFACE_KIND')" >&2
    usage
    ;;
esac

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
# resolve_skill_link_path <out_abs> <skill_name>
#
# TD-218 (Option C): compute the per-skill symlink link_path with a de-dup
# guard. MUST stay byte-identical to the same helper in compile_harnesses.sh
# (L-519 §18.1 / L-554 — drift derives the expected layout the same way
# compile creates it). The contract is that the target `path` (→ out_abs) is
# the PARENT skills dir, and the loop appends `/<skill_name>`. A LEGACY/hand-
# edited manifest may carry a per-skill `path` that already ends in
# `/<skill_name>` (e.g. `~/.agents/skills/content-pipeline`); naively
# appending would double-nest to `<out_abs>/<skill_name>/<skill_name>/
# SKILL.md` (depth-2), which native loaders (depth-1 scan) never discover.
# When out_abs already terminates in <skill_name>, treat it as the link
# target itself and do NOT append. Echoes the resolved link_path on stdout.
# See TD-218.
# ---------------------------------------------------------------------------
resolve_skill_link_path() {
  local out_abs="$1"
  local skill_name="$2"
  if [ "$(basename "$out_abs")" = "$skill_name" ]; then
    printf '%s\n' "$out_abs"
  else
    printf '%s\n' "$out_abs/$skill_name"
  fi
}

# ---------------------------------------------------------------------------
# verify_md_agent_symlink_drift <name> <harness_label> <target_abs>
#
# FR-152 / FR-158 / FR-159 / FR-171 / TD-208 per-harness drift verdict for
# claude + codex + gemini + opencode AGENT targets. Each harness has its own
# registry-resident expected file
# (`<BRAIN_DIR>/registry/agents/<name>/harness.<label>.<ext>`, where ext = `md`
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
#   DRIFTED — symlink resolves outside the registry (legacy reference-mode).
#   DRIFTED — symlink resolves inside the registry but to the wrong file.
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

  # FR-159: codex's expected registry file is harness.codex.toml (TOML, not
  # Markdown). Claude/gemini stay on .md. The rest of the function is
  # extension-agnostic — the symlink/realpath compare cares only about
  # paths, not file contents.
  local harness_ext="md"
  if [ "$harness_label" = "codex" ]; then
    harness_ext="toml"
  fi
  local expected_target="$BRAIN_DIR/registry/agents/$name/harness.${harness_label}.${harness_ext}"

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
# verify_gemini_agent_hardlink_drift <name> <target_abs> <expected_target>
#
# TD-208 hard-link drift verdict for the Gemini agent target. The target is a
# HARD LINK to <expected_target> — inode equality is the primary MATCH signal.
# The Gemini subagent loader does NOT follow symbolic links (verified live
# 2026-06-01) but DOES follow hard links; the registry-canonical (L-516)
# invariant is preserved because hard link = same inode = same bytes-on-disk
# = registry remains the single physical home.
#
# Verdict ordering (L-28 precondition discipline mirrors verify_mirror.sh):
#   1. expected_target MISSING in registry → DRIFTED (compile never ran).
#   2. target is a symbolic link → DRIFTED (legacy pre-TD-208 emit; recompile
#      migrates to hard link).
#   3. inode(target) == inode(expected_target) AND nlink(expected_target) >= 2
#      → MATCH (correctly hard-linked).
#   4. inode mismatch BUT byte-content equal (md5) → DRIFT-WARN. Operator
#      manually `cp`-replaced the hard link; content is fine but the primitive
#      contract is broken (L-516 violated — there are now TWO bytes-on-disk
#      copies, not one). DRIFT-WARN counts as drift (exit 1).
#   5. inode mismatch AND byte-content differs → DRIFTED (target diverged
#      from registry; recompile re-establishes).
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
    echo "      expected  : $expected_target [absent in registry]"
    echo "      reason    : registry harness.gemini.md missing — run \`igris harness compile\` to assemble + hard-link"
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
    echo "      registry  : $expected_target"
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
    echo "      reason    : target content matches registry but the file is a real-file copy, not a hard link (operator manually \`cp\`-replaced, or CLI bug) — content fine, primitive wrong; run \`igris harness compile\` to re-establish the hard link"
    # DRIFT-WARN counts as drift in the summary (exit 1) — content equality
    # is a soft signal but the primitive contract is broken (L-516 violated).
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  # Inode mismatch AND content differs — hard drift.
  echo "  [$name/gemini] DRIFTED"
  echo "      target    : $target_abs [inode $tgt_inode, content differs]"
  echo "      expected  : $expected_target [inode $src_inode]"
  echo "      reason    : gemini target diverged from registry (different bytes AND different inode) — run \`igris harness compile\` to re-establish"
  DRIFT=$((DRIFT + 1))
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
# verify_identity_file_drift <harness> <target_path> <template_path> <version>
#
# TD-233 (GAP-3): per-(identity,harness) drift verdict, line-paired with the
# compile identity pass (§18.1). Re-derives the EXPECTED delimited region via
# the SHARED normalize_identity_shape (the same helper compile writes with —
# no second normalizer), extracts the ON-DISK region via
# extract_identity_region, and byte-compares.
#
# Verdicts (updates caller-scoped MATCH/DRIFT, same as the other verdict fns):
#   MISSING — identity file absent (extract rc 10) OR file present but with NO
#             Igris identity region (rc 11). Both mean the projection was
#             never run / was stripped → run `igris harness compile`. DRIFT++.
#   DRIFTED — corrupt region (BEGIN without END, rc 12), template missing,
#             unresolvable {{IGRIS_VERSION}}, or region bytes diverge from
#             canonical. DRIFT++.
#   MATCH   — on-disk region byte-equals the expected region. MATCH++.
#
# The path line uses the `artifact` label so the pre-commit wrapper's
# classifier (scripts/validate_harness_drift.sh) resolves it and treats a
# MISSING project-relative identity file as FATAL (you forgot to compile).
# NEVER throws under set -e.
# ---------------------------------------------------------------------------
verify_identity_file_drift() {
  local harness="$1"
  local target_path="$2"
  local template_path="$3"
  local version="$4"

  if [ ! -f "$template_path" ]; then
    echo "  [identity/$harness] DRIFTED"
    echo "      artifact  : $target_path"
    echo "      reason    : canonical identity template missing: $template_path — restore it, then run \`igris harness compile\`"
    DRIFT=$((DRIFT + 1))
    return 0
  fi
  if [ -z "$version" ]; then
    echo "  [identity/$harness] DRIFTED"
    echo "      artifact  : $target_path"
    echo "      reason    : cannot resolve {{IGRIS_VERSION}} (version_source/config.json missing, unparseable, or key-less) — cannot re-derive the expected region"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  # Expected region via the SHARED shape helper (what compile writes).
  local expected norm_rc=0
  expected=$(normalize_identity_shape "$template_path" "$harness" "$version") || norm_rc=$?
  if [ "$norm_rc" -ne 0 ]; then
    echo "  [identity/$harness] DRIFTED"
    echo "      artifact  : $target_path"
    echo "      reason    : normalize_identity_shape exited $norm_rc"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  # On-disk region. rc 0 = present; 10 = file absent; 11 = no region; 12 =
  # corrupt (BEGIN without END). $(...) strips trailing newlines on BOTH
  # sides identically, so the byte-compare stays faithful.
  local on_disk extract_rc=0
  on_disk=$(extract_identity_region "$target_path") || extract_rc=$?

  if [ "$extract_rc" -eq 10 ]; then
    echo "  [identity/$harness] MISSING"
    echo "      artifact  : $target_path"
    echo "      reason    : identity file absent — run \`igris harness compile\` to project it"
    DRIFT=$((DRIFT + 1))
    return 0
  fi
  if [ "$extract_rc" -eq 11 ]; then
    echo "  [identity/$harness] MISSING"
    echo "      artifact  : $target_path"
    echo "      reason    : file exists but carries no Igris identity region — run \`igris harness compile\` to inject it (user content is preserved)"
    DRIFT=$((DRIFT + 1))
    return 0
  fi
  if [ "$extract_rc" -eq 12 ]; then
    echo "  [identity/$harness] DRIFTED"
    echo "      artifact  : $target_path"
    echo "      reason    : corrupt Igris identity region (BEGIN marker without END) — fix the file manually, then run \`igris harness compile\`"
    DRIFT=$((DRIFT + 1))
    return 0
  fi
  if [ "$extract_rc" -ne 0 ]; then
    echo "  [identity/$harness] DRIFTED"
    echo "      artifact  : $target_path"
    echo "      reason    : could not read the identity region (extract rc $extract_rc)"
    DRIFT=$((DRIFT + 1))
    return 0
  fi

  if [ "$on_disk" = "$expected" ]; then
    echo "  [identity/$harness] MATCH"
    echo "      artifact  : $target_path"
    MATCH=$((MATCH + 1))
  else
    echo "  [identity/$harness] DRIFTED"
    echo "      artifact  : $target_path"
    echo "      reason    : identity region diverges from canonical (edited in place, or the canonical/version moved) — run \`igris harness compile\` to re-project"
    DRIFT=$((DRIFT + 1))
  fi
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
    # resolution can be keyed on it (core -> in-repo, personal -> registry).
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
# FR-156: per-agent tree-hash verdict is fired ONCE per agent (the loop walks
# per-target rows, so a 3-target agent would otherwise emit 3 tree verdicts).
# Tracked as a colon-delimited string `:name1:name2:` so the membership check
# `case "$TREE_CHECKED" in *":$name:"*)` works under bash 3.2 (macOS default
# — no associative arrays).
TREE_CHECKED=":"
# TD-201: per-skill-NAME tree-hash dedup (a multi-target skill block fires one
# tree verdict, not one per (type, method) row). Same idiom as TREE_CHECKED.
SKILL_TREE_CHECKED=":"

echo "Harness drift check (project root: $PROJECT_ROOT):"
echo ""

# FR-180: agents drift pass — gated on --surface (default `all`). When `igris
# add` scopes the verify to a non-agents surface this loop is skipped entirely.
if { [ "$SURFACE_KIND" = "agents" ] || [ "$SURFACE_KIND" = "all" ]; } && [ -n "$WORK_ROWS" ]; then
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

  # FR-156: TREE pre-check. ONE verdict per agent (deduped via TREE_CHECKED)
  # comparing the vendored registry tree against the recorded path-origin's
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
    tree_origins_path="$BRAIN_DIR/registry/origins.json"
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
        tree_registry_dir="$BRAIN_DIR/registry/agents/$name"
        if [ ! -d "$tree_registry_dir" ]; then
          echo "  [$name/tree] DRIFTED — registry dir absent: $tree_registry_dir"
          DRIFT=$((DRIFT + 1))
        elif [ ! -d "$tree_origin_dir" ]; then
          echo "  [$name/tree] NOTE — source dir gone ($tree_origin_dir); tree drift undetectable, per-target verify continues"
        else
          tree_expected=$(hash_agent_tree "$tree_registry_dir")
          tree_actual=$(hash_agent_tree "$tree_origin_dir")
          if [ "$tree_expected" = "$tree_actual" ]; then
            echo "  [$name/tree] MATCH"
            MATCH=$((MATCH + 1))
          else
            echo "  [$name/tree] DRIFTED"
            echo "      registry  : $tree_registry_dir (sha $tree_expected)"
            echo "      source    : $tree_origin_dir (sha $tree_actual)"
            # Locate up to N=5 differing relpaths so the operator can act
            # without re-deriving the diff manually. Skip-list MUST stay byte-
            # for-byte in sync with TS isAgentTreeSkipped and bash
            # hash_agent_tree (TD-202: REGISTRY-NOTICE.md added).
            tree_diff=$(python3 - "$tree_registry_dir" "$tree_origin_dir" <<'PY'
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


a = walk(sys.argv[1])  # registry
b = walk(sys.argv[2])  # source
diffs = []
keys = sorted(set(a) | set(b))
for k in keys:
    if k not in a:
        diffs.append("+ " + k + " (only in source)")
    elif k not in b:
        diffs.append("- " + k + " (only in registry)")
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
            echo "      reason    : agent tree diverges from recorded path-origin source — \`igris registry update $name\` re-vendors"
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
  # registry-resident assembled file (`harness.claude.md`, `harness.codex.toml`,
  # `harness.gemini.md`, `harness.opencode.md` respectively — NOT body sha).
  # Pair line-for-line with `compile_md_agent_target` (L-519 §18.1
  # compile/drift-verify pairing). opencode follows symlinks (verified live) so
  # it shares the claude symlink-verdict branch (harness_ext=md). Both sides of
  # the containment check are realpath'd so macOS `/var` → `/private/var` (and
  # similar symlink-resolved TMPDIR prefixes) do not produce false
  # "not registry-anchored" verdicts.
  if [ "$ttype" = "claude" ] || [ "$ttype" = "gemini" ] || [ "$ttype" = "codex" ] || [ "$ttype" = "opencode" ]; then
    verify_md_agent_symlink_drift "$name" "$ttype" "$target_abs"
    continue
  fi

  # No other agent target types are supported.
  echo "  [$name/$ttype] DRIFTED — unknown target type"
  DRIFT=$((DRIFT + 1))
done <<< "$WORK_ROWS"
fi

# ---------------------------------------------------------------------------
# FR-180 (TD-235 / D5): mirror of compile's loud-vs-silent core-skip diagnostic.
# The flatten gate below keeps its own in-Python commonpath check verbatim
# (verdict bytes unchanged); this block only adds the diagnostic + exit
# decision. Same three cases as compile_harnesses.sh's skills pass.
# FR-180: gated on --surface (skills) so a non-skills scoped verify doesn't emit
# this skills-specific diagnostic.
# ---------------------------------------------------------------------------
if { [ "$SURFACE_KIND" = "skills" ] || [ "$SURFACE_KIND" = "all" ]; } \
   && core_skills_declared "$CORE_SURFACES" \
   && ! core_surfaces_owned "$CORE_SURFACES" "$PROJECT_ROOT"; then
  if [ "$EXPECT_CORE" -eq 1 ]; then
    echo "FAIL  core skills — not owned by --project-root $PROJECT_ROOT; run from the igris-ai repo or pass --core" >&2
    DRIFT=$((DRIFT + 1))
    TOTAL=$((TOTAL + 1))
  else
    echo "SKIPPED core surfaces (personal-project compile)" >&2
  fi
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

if { [ "$SURFACE_KIND" = "skills" ] || [ "$SURFACE_KIND" = "all" ]; } && [ -n "$SKILL_ROWS" ]; then
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

    # TD-201: skill TREE pre-check. ONE verdict per personal skill block
    # regardless of how many (type, method) targets it declares. Mirrors the
    # FR-156 agent tree pre-check above — `hash_agent_tree` is intentionally
    # reused (Option B): the algorithm (sorted relpath + \0 + bytes folded
    # into sha256) is surface-agnostic. See L-519 / TD-201 plan §2.
    #
    # Gated to layer=personal. Core skills (declared in surfaces-manifest.json)
    # have no registry-vendored copy to drift against, so this is a silent
    # no-op for them — same posture as FR-156's agent tree pre-check.
    # MATCH/DRIFT counters bump WITHOUT TOTAL++, mirroring FR-156's posture
    # exactly (the per-target FR-152 row counts toward TOTAL; this is an
    # orthogonal pre-check). Dedup is keyed on the skill NAME (basename of
    # src_abs, which is `registrySkillDirPath(<name>)` per L-517).
    #
    # SHAPE NOTE: `igris registry add-skill` vendors a single-skill source
    # (containing top-level `SKILL.md`) as `<src_abs>/<skill_name>/...` —
    # the vendor primitive name-prefixes (see `vendorSkillTreeAtomic` in
    # cli/src/verbs/registry.ts:1217). So to compare apples-to-apples with
    # the operator's original `origin.dir` (which has `SKILL.md` at root),
    # the registry side is hashed one level DOWN at `<src_abs>/<name>`.
    if [ "$s_layer" = "personal" ] && [ -n "$src_abs" ]; then
      skill_name="$(basename "$src_abs")"
      # FR-180 (S1): honor --filter on the per-skill tree drift pre-check too,
      # so `igris add`'s scoped verify doesn't surface a pre-existing UNRELATED
      # personal skill's tree drift as this add's failure.
      if skill_name_matches_filter "$skill_name" "$FILTER"; then
      skill_registry_dir="$src_abs/$skill_name"
      skill_dedup_already=0
      case "$SKILL_TREE_CHECKED" in
        *":$skill_name:"*) skill_dedup_already=1 ;;
      esac
      if [ "$skill_dedup_already" -eq 0 ]; then
        SKILL_TREE_CHECKED="${SKILL_TREE_CHECKED}${skill_name}:"
        skill_origins_path="$BRAIN_DIR/registry/origins.json"
        skill_origin_info=""
        if [ -f "$skill_origins_path" ]; then
          skill_origin_info=$(python3 - "$skill_origins_path" "$skill_name" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        origins = json.load(fh)
except OSError:
    sys.exit(0)
o = origins.get("skill:" + sys.argv[2])
if not isinstance(o, dict):
    sys.exit(0)
otype = o.get("type", "")
if otype == "path":
    print(otype + "\t" + (o.get("dir") or ""))
elif otype == "github":
    print(otype + "\t" + (o.get("repo") or "") + "@" + (o.get("ref") or ""))
PY
)
        fi
        if [ -z "$skill_origin_info" ]; then
          : # no origin recorded for this personal skill — silent skip. The
            # per-target FR-153 verdict below still fires. Same zero-migration
            # posture as the FR-156 agent pre-check.
        else
          skill_origin_type="${skill_origin_info%%	*}"
          skill_origin_payload="${skill_origin_info#*	}"
          if [ "$skill_origin_type" = "path" ]; then
            skill_origin_dir="$skill_origin_payload"
            case "$skill_origin_dir" in
              "~"/*) skill_origin_dir="$HOME/${skill_origin_dir#"~/"}" ;;
            esac
            if [ ! -d "$skill_registry_dir" ]; then
              echo "  [$skill_name/tree] DRIFTED — registry dir absent: $skill_registry_dir"
              DRIFT=$((DRIFT + 1))
            elif [ ! -d "$skill_origin_dir" ]; then
              echo "  [$skill_name/tree] NOTE — source dir gone ($skill_origin_dir); tree drift undetectable, per-target verify continues"
            else
              skill_tree_expected=$(hash_agent_tree "$skill_registry_dir")
              skill_tree_actual=$(hash_agent_tree "$skill_origin_dir")
              if [ "$skill_tree_expected" = "$skill_tree_actual" ]; then
                echo "  [$skill_name/tree] MATCH"
                MATCH=$((MATCH + 1))
              else
                echo "  [$skill_name/tree] DRIFTED"
                echo "      registry  : $skill_registry_dir (sha $skill_tree_expected)"
                echo "      source    : $skill_origin_dir (sha $skill_tree_actual)"
                # Locate up to N=5 differing relpaths. Identical skip-list and
                # cap to the FR-156 agent diff walker (so the two stay in
                # lockstep). Diff emits relpaths only — no body bytes ever
                # printed (L-515 read-only posture). TD-202: REGISTRY-NOTICE.md
                # added to skip-list — vendored-copy sidecar must not register
                # as drift against the operator's source (which lacks it).
                skill_tree_diff=$(python3 - "$skill_registry_dir" "$skill_origin_dir" <<'PY'
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
            # FR-158 / FR-159: per-harness α-assembly output exclusion is
            # moot for skills (no α-assembly output) but kept for parity
            # with hash_agent_tree — see TD-201 plan §2 + FR-158 + FR-159.
            if rel in ("harness.claude.md", "harness.gemini.md", "harness.codex.toml", "harness.opencode.md"):
                continue
            try:
                with open(abs_p, "rb") as fh:
                    out[rel] = hashlib.sha256(fh.read()).hexdigest()
            except OSError:
                out[rel] = "<unreadable>"
    return out


a = walk(sys.argv[1])  # registry
b = walk(sys.argv[2])  # source
diffs = []
keys = sorted(set(a) | set(b))
for k in keys:
    if k not in a:
        diffs.append("+ " + k + " (only in source)")
    elif k not in b:
        diffs.append("- " + k + " (only in registry)")
    elif a[k] != b[k]:
        diffs.append("~ " + k + " (contents differ)")
N = 5
for d in diffs[:N]:
    print("      " + d)
if len(diffs) > N:
    print("      (... and {} more)".format(len(diffs) - N))
PY
)
                if [ -n "$skill_tree_diff" ]; then
                  printf '%s\n' "$skill_tree_diff"
                fi
                echo "      reason    : skill tree diverges from recorded path-origin source — \`igris registry add-skill --name $skill_name --from <src>\` re-vendors"
                DRIFT=$((DRIFT + 1))
              fi
            fi
          elif [ "$skill_origin_type" = "github" ]; then
            echo "  [$skill_name/tree] NOTE — github origin ($skill_origin_payload); freshness is release-tag tracked, tree-hash drift not applicable"
          fi
        fi
      fi
      fi  # FR-180 (S1): close skill_name_matches_filter guard
    fi

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
        any_too_deep=0
        checked=0
        while IFS= read -r -d '' skill_md; do
          skill_name="$(basename "$(dirname "$skill_md")")"
          # FR-180 (S1): honor --filter on the skills surface (parity with the
          # agent flatten + compile_harnesses.sh skills branches). Scopes
          # `igris add`'s verify to the just-added skill. §18.1 paired change.
          skill_name_matches_filter "$skill_name" "$FILTER" || continue
          skill_dir="$(dirname "$skill_md")"
          skill_dir_real=$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")
          link_path="$(resolve_skill_link_path "$out_abs" "$skill_name")"
          if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
            any_missing=1
          elif [ -L "$link_path" ]; then
            resolved=$(realpath "$link_path" 2>/dev/null || true)
            if [ -z "$resolved" ]; then
              any_drift=1
            else
              # FR-180 cross-phase: the COMPILE side (the §18.1 source of truth)
              # creates the per-skill symlink pointing at <conv_root>/<name>
              # (`skill_dir`). For a CORE skill conv_root is `~/.igris/core/skills`
              # (the surfaces-manifest `~`-prefixed source), so the canonical
              # symlink target is NOT under the registry — it points straight at
              # core. The MATCH condition is therefore "resolves to the canonical
              # source compile linked" (`resolved == skill_dir_real`), which holds
              # for BOTH a registry-vendored personal skill (skill_dir under the
              # registry) AND a core skill (skill_dir under core/skills). The
              # registry-containment check is retained ONLY to distinguish a
              # registry-anchored-but-WRONG-file drift from a genuinely unanchored
              # (points-nowhere-canonical) symlink. Without this, every core skill
              # false-DRIFTED as "not registry-anchored" whenever the check was
              # scoped to a root that OWNS the core surfaces (e.g. `igris add
              # --core`'s brain-root verify) — a pre-existing check/compile
              # divergence masked while core skills were never checked from an
              # owning root.
              if [ "$resolved" = "$skill_dir_real" ]; then
                : # MATCH — symlink points at the canonical source compile linked.
              else
                case "$resolved" in
                  "$registry_real"/*|"$registry_real")
                    # Registry-anchored but NOT the expected canonical file.
                    any_drift=1
                    ;;
                  *)
                    any_unanchored=1
                    ;;
                esac
              fi
            fi
            # TD-218: depth-1 discoverability — SKILL.md MUST be at
            # <link_path>/SKILL.md. A registry-anchored-but-too-deep symlink
            # (legacy per-skill target.path) leaves SKILL.md one level deeper,
            # invisible to native loaders that scan depth-1.
            if [ ! -f "$link_path/SKILL.md" ]; then
              any_too_deep=1
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
        elif [ "$any_too_deep" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more claude skill symlinks resolve but SKILL.md is not at depth-1 (<link_path>/SKILL.md missing) — native loaders scan depth-1; repair target.path to the PARENT skills dir, then run \`igris harness compile\`"
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
        any_too_deep=0
        any_relative_codex=0
        checked=0
        while IFS= read -r -d '' skill_md; do
          skill_name="$(basename "$(dirname "$skill_md")")"
          # FR-180 (S1): honor --filter on the skills surface (parity with the
          # agent flatten + compile_harnesses.sh skills branches). Scopes
          # `igris add`'s verify to the just-added skill. §18.1 paired change.
          skill_name_matches_filter "$skill_name" "$FILTER" || continue
          skill_dir="$(dirname "$skill_md")"
          skill_dir_real=$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")
          link_path="$(resolve_skill_link_path "$out_abs" "$skill_name")"
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
              # FR-180 cross-phase: the COMPILE side (the §18.1 source of truth)
              # creates the per-skill symlink pointing at <conv_root>/<name>
              # (`skill_dir`). For a CORE skill conv_root is `~/.igris/core/skills`
              # (the surfaces-manifest `~`-prefixed source), so the canonical
              # symlink target is NOT under the registry — it points straight at
              # core. The MATCH condition is therefore "resolves to the canonical
              # source compile linked" (`resolved == skill_dir_real`), which holds
              # for BOTH a registry-vendored personal skill (skill_dir under the
              # registry) AND a core skill (skill_dir under core/skills). The
              # registry-containment check is retained ONLY to distinguish a
              # registry-anchored-but-WRONG-file drift from a genuinely unanchored
              # (points-nowhere-canonical) symlink. Without this, every core skill
              # false-DRIFTED as "not registry-anchored" whenever the check was
              # scoped to a root that OWNS the core surfaces (e.g. `igris add
              # --core`'s brain-root verify) — a pre-existing check/compile
              # divergence masked while core skills were never checked from an
              # owning root.
              if [ "$resolved" = "$skill_dir_real" ]; then
                : # MATCH — symlink points at the canonical source compile linked.
              else
                case "$resolved" in
                  "$registry_real"/*|"$registry_real")
                    # Registry-anchored but NOT the expected canonical file.
                    any_drift=1
                    ;;
                  *)
                    any_unanchored=1
                    ;;
                esac
              fi
            fi
            # TD-218: depth-1 discoverability — SKILL.md MUST be at
            # <link_path>/SKILL.md. A registry-anchored-but-too-deep symlink
            # (legacy per-skill target.path) leaves SKILL.md one level deeper,
            # invisible to native loaders that scan depth-1.
            if [ ! -f "$link_path/SKILL.md" ]; then
              any_too_deep=1
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
        elif [ "$any_too_deep" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more codex skill symlinks resolve but SKILL.md is not at depth-1 (<link_path>/SKILL.md missing) — native loaders scan depth-1; repair target.path to the PARENT skills dir, then run \`igris harness compile\`"
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
        any_too_deep=0
        checked=0
        while IFS= read -r -d '' skill_md; do
          skill_name="$(basename "$(dirname "$skill_md")")"
          # FR-180 (S1): honor --filter on the skills surface (parity with the
          # agent flatten + compile_harnesses.sh skills branches). Scopes
          # `igris add`'s verify to the just-added skill. §18.1 paired change.
          skill_name_matches_filter "$skill_name" "$FILTER" || continue
          skill_dir="$(dirname "$skill_md")"
          skill_dir_real=$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")
          link_path="$(resolve_skill_link_path "$out_abs" "$skill_name")"
          if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
            any_missing=1
          elif [ -L "$link_path" ]; then
            resolved=$(realpath "$link_path" 2>/dev/null || true)
            if [ -z "$resolved" ]; then
              any_drift=1
            else
              # FR-180 cross-phase: the COMPILE side (the §18.1 source of truth)
              # creates the per-skill symlink pointing at <conv_root>/<name>
              # (`skill_dir`). For a CORE skill conv_root is `~/.igris/core/skills`
              # (the surfaces-manifest `~`-prefixed source), so the canonical
              # symlink target is NOT under the registry — it points straight at
              # core. The MATCH condition is therefore "resolves to the canonical
              # source compile linked" (`resolved == skill_dir_real`), which holds
              # for BOTH a registry-vendored personal skill (skill_dir under the
              # registry) AND a core skill (skill_dir under core/skills). The
              # registry-containment check is retained ONLY to distinguish a
              # registry-anchored-but-WRONG-file drift from a genuinely unanchored
              # (points-nowhere-canonical) symlink. Without this, every core skill
              # false-DRIFTED as "not registry-anchored" whenever the check was
              # scoped to a root that OWNS the core surfaces (e.g. `igris add
              # --core`'s brain-root verify) — a pre-existing check/compile
              # divergence masked while core skills were never checked from an
              # owning root.
              if [ "$resolved" = "$skill_dir_real" ]; then
                : # MATCH — symlink points at the canonical source compile linked.
              else
                case "$resolved" in
                  "$registry_real"/*|"$registry_real")
                    # Registry-anchored but NOT the expected canonical file.
                    any_drift=1
                    ;;
                  *)
                    any_unanchored=1
                    ;;
                esac
              fi
            fi
            # TD-218: depth-1 discoverability — SKILL.md MUST be at
            # <link_path>/SKILL.md. A registry-anchored-but-too-deep symlink
            # (legacy per-skill target.path) leaves SKILL.md one level deeper,
            # invisible to native loaders that scan depth-1.
            if [ ! -f "$link_path/SKILL.md" ]; then
              any_too_deep=1
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
        elif [ "$any_too_deep" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more gemini skill symlinks resolve but SKILL.md is not at depth-1 (<link_path>/SKILL.md missing) — native loaders scan depth-1; repair target.path to the PARENT skills dir, then run \`igris harness compile\`"
        fi
        echo "  [skills/$s_type] $verdict"
        echo "      source     : $conv_root"
        echo "      artifact dir: $out_abs ($checked skills checked)"
        ;;
      agents/symlink)
        # FR-157: per-skill symlinks at the cross-CLI shared `~/.agents/skills/`
        # standard. Byte-for-byte mirror of codex/symlink including the D2
        # absolute-literal-target verdict — codex resolves relative symlinks
        # from cwd regardless of where the symlink LIVES, so the hazard
        # applies to `~/.agents/skills/` too. See L-519 §18.1, FR-157.
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
        any_too_deep=0
        any_relative_agents=0
        checked=0
        while IFS= read -r -d '' skill_md; do
          skill_name="$(basename "$(dirname "$skill_md")")"
          # FR-180 (S1): honor --filter on the skills surface (parity with the
          # agent flatten + compile_harnesses.sh skills branches). Scopes
          # `igris add`'s verify to the just-added skill. §18.1 paired change.
          skill_name_matches_filter "$skill_name" "$FILTER" || continue
          skill_dir="$(dirname "$skill_md")"
          skill_dir_real=$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")
          link_path="$(resolve_skill_link_path "$out_abs" "$skill_name")"
          if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
            any_missing=1
          elif [ -L "$link_path" ]; then
            # FR-157 D2: literal target must be absolute (codex re-resolves
            # relative symlinks from cwd). Check readlink BEFORE realpath.
            literal=$(readlink "$link_path" 2>/dev/null || true)
            case "$literal" in
              /*) : ;;
              *) any_relative_agents=1 ;;
            esac
            resolved=$(realpath "$link_path" 2>/dev/null || true)
            if [ -z "$resolved" ]; then
              any_drift=1
            else
              # FR-180 cross-phase: the COMPILE side (the §18.1 source of truth)
              # creates the per-skill symlink pointing at <conv_root>/<name>
              # (`skill_dir`). For a CORE skill conv_root is `~/.igris/core/skills`
              # (the surfaces-manifest `~`-prefixed source), so the canonical
              # symlink target is NOT under the registry — it points straight at
              # core. The MATCH condition is therefore "resolves to the canonical
              # source compile linked" (`resolved == skill_dir_real`), which holds
              # for BOTH a registry-vendored personal skill (skill_dir under the
              # registry) AND a core skill (skill_dir under core/skills). The
              # registry-containment check is retained ONLY to distinguish a
              # registry-anchored-but-WRONG-file drift from a genuinely unanchored
              # (points-nowhere-canonical) symlink. Without this, every core skill
              # false-DRIFTED as "not registry-anchored" whenever the check was
              # scoped to a root that OWNS the core surfaces (e.g. `igris add
              # --core`'s brain-root verify) — a pre-existing check/compile
              # divergence masked while core skills were never checked from an
              # owning root.
              if [ "$resolved" = "$skill_dir_real" ]; then
                : # MATCH — symlink points at the canonical source compile linked.
              else
                case "$resolved" in
                  "$registry_real"/*|"$registry_real")
                    # Registry-anchored but NOT the expected canonical file.
                    any_drift=1
                    ;;
                  *)
                    any_unanchored=1
                    ;;
                esac
              fi
            fi
            # TD-218: depth-1 discoverability — SKILL.md MUST be at
            # <link_path>/SKILL.md. A registry-anchored-but-too-deep symlink
            # (legacy per-skill target.path) leaves SKILL.md one level deeper,
            # invisible to native loaders that scan depth-1.
            if [ ! -f "$link_path/SKILL.md" ]; then
              any_too_deep=1
            fi
          else
            any_realfile=1
          fi
          checked=$((checked + 1))
        done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                   -name 'SKILL.md' -print0 | sort -z)
        if [ "$any_missing" -eq 1 ]; then
          verdict="MISSING"
          reason="one or more agents skill symlinks absent"
        elif [ "$any_realfile" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more target paths are regular files/dirs, not symlinks (legacy reference-mode state — remove manually, then run \`igris harness compile\`)"
        elif [ "$any_unanchored" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more agents skill symlinks not registry-anchored (legacy reference-mode state — run \`igris harness compile\` to migrate)"
        elif [ "$any_drift" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more agents skill symlinks point at the wrong canonical (registry-anchored but mismatched)"
        elif [ "$any_too_deep" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more agents skill symlinks resolve but SKILL.md is not at depth-1 (<link_path>/SKILL.md missing) — native loaders scan depth-1; repair target.path to the PARENT skills dir, then run \`igris harness compile\`"
        elif [ "$any_relative_agents" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more agents skill symlinks have a relative target (codex resolves these from cwd, not symlink location — FR-157 D2)"
        fi
        echo "  [skills/$s_type] $verdict"
        echo "      source     : $conv_root"
        echo "      artifact dir: $out_abs ($checked skills checked)"
        ;;
      opencode/command)
        # FR-171: thin command wrappers (Option A). For each <name>/SKILL.md
        # under the source root, a `<out_abs>/<name>.md` wrapper must exist,
        # carry our generated-marker (line 1), and load the canonical SKILL.md
        # via the expected `@~/.igris/core/skills/<name>/SKILL.md` directive.
        # Verdicts (pair line-for-line with the compile branch, L-519 §18.1):
        #   MISSING  — one or more wrapper files absent (or roster count ≠
        #              wrapper count → count-parity failure, same signal).
        #   DRIFTED  — a wrapper is a symlink (foreign shape), OR lacks the
        #              generated-marker (hand-authored — would be refused at
        #              compile), OR its `@`-target points at the wrong skill.
        #   MATCH    — every roster skill has a marked wrapper with the correct
        #              `@`-target.
        conv_root="${src_abs:-$HOME/.igris/core/skills}"
        if [ ! -d "$conv_root" ]; then
          echo "  [skills/$s_type] MISSING — skills root absent: $conv_root"
          DRIFT=$((DRIFT + 1))
          continue
        fi
        any_missing=0
        any_symlink=0
        any_unmarked=0
        any_wrong_target=0
        checked=0
        # FR-171 marker — MUST byte-match OPENCODE_COMMAND_MARKER in
        # compile_harnesses.sh (§18.1 compile/drift pairing).
        oc_marker="<!-- Generated by igris harness compile (FR-171 opencode/command) — edit the canonical SKILL.md, not this wrapper -->"
        while IFS= read -r -d '' skill_md; do
          skill_name="$(basename "$(dirname "$skill_md")")"
          # FR-180 (S1): honor --filter on the skills surface (parity with the
          # other 4 check branches + compile). Scopes `igris add`'s verify.
          skill_name_matches_filter "$skill_name" "$FILTER" || continue
          link_path="$out_abs/$skill_name.md"
          # FR-171: expected `@`-target is the ACTUAL canonical SKILL.md the
          # compile walked (~`-prefixed when under $HOME), computed identically
          # to compile's opencode_at_target (L-519 §18.1 — same source walk).
          case "$skill_md" in
            "$HOME"/*) expected_at="@~/${skill_md#"$HOME"/}" ;;
            *)         expected_at="@$skill_md" ;;
          esac
          if [ -L "$link_path" ]; then
            any_symlink=1
          elif [ ! -e "$link_path" ]; then
            any_missing=1
          else
            first_line="$(head -n 1 "$link_path" 2>/dev/null || true)"
            if [ "$first_line" != "$oc_marker" ]; then
              any_unmarked=1
            elif ! grep -qF -- "$expected_at" "$link_path" 2>/dev/null; then
              any_wrong_target=1
            fi
          fi
          checked=$((checked + 1))
        done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                   -name 'SKILL.md' -print0 | sort -z)
        if [ "$any_missing" -eq 1 ]; then
          verdict="MISSING"
          reason="one or more opencode command wrappers absent (run \`igris harness compile\`)"
        elif [ "$any_symlink" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more opencode command targets are symlinks (a command wrapper is a real file — remove manually, then run \`igris harness compile\`)"
        elif [ "$any_unmarked" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more opencode command wrappers lack the FR-171 generated-marker (hand-authored file at a generated path — remove manually if it should be a generated wrapper)"
        elif [ "$any_wrong_target" -eq 1 ]; then
          verdict="DRIFTED"
          reason="one or more opencode command wrappers do not load the expected canonical SKILL.md via @file (run \`igris harness compile\`)"
        fi
        echo "  [skills/$s_type] $verdict"
        echo "      source     : $conv_root"
        echo "      artifact dir: $out_abs ($checked wrappers checked)"
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

# ---------------------------------------------------------------------------
# FR-164 (FR-160 epic): MCP-server drift pass, line-paired with the compile MCP
# pass (§18.1). Flattens the SAME (mcp,target) rows via `flatten_mcp_rows`
# (target_kind="all" — drift checks all 4 harness targets per block, consistent
# with drift's "check everything" posture). For each row it resolves the harness
# config path + map key and calls `verify_mcp_entry_drift` (which reads the
# on-disk entry, derives the expected shape via the SHARED normalize_mcp_shape,
# and compares — re-resolving codex literals inside the compare WITHOUT printing
# any value).
#
# Config-path resolution honors per-harness env overrides (test sandbox seam)
# then falls back to the native default ($HOME-anchored, matching paths.ts).
# secrets.env is resolved from <brain>/secrets.env (honored by the codex
# re-resolve) with an IGRIS_SECRETS_PATH override for tests.
# ---------------------------------------------------------------------------
MCP_DRIFT_ROWS=$(flatten_mcp_rows "$MERGED_MANIFEST" "$CORE_SURFACES" "all" "$PROJECT_ROOT")
if { [ "$SURFACE_KIND" = "mcp" ] || [ "$SURFACE_KIND" = "all" ]; } && [ -n "$MCP_DRIFT_ROWS" ]; then
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

# ---------------------------------------------------------------------------
# TD-233 (GAP-3): orchestrator-identity drift pass, line-paired with the
# compile identity pass (§18.1). Flattens the SAME (identity,target) rows via
# `flatten_identity_rows` (target_kind="all" — drift checks every harness
# target, consistent with drift's "check everything" posture). Per row it
# resolves the canonical template, the {{IGRIS_VERSION}} source and the output
# file (all FR-154 3-case, mirroring compile) and calls
# `verify_identity_file_drift`, which re-derives the expected delimited region
# via the SHARED normalize_identity_shape and byte-compares ONLY the
# Igris-managed region (user content around it is theirs and is never
# inspected). FR-180: gated on --surface (identity) so a scoped verify of
# another surface doesn't re-check the os_identity region (whose
# {{IGRIS_VERSION}} cannot resolve under a brain-root project-root).
# ---------------------------------------------------------------------------
IDENTITY_DRIFT_ROWS=$(flatten_identity_rows "$MERGED_MANIFEST" "$CORE_SURFACES" "all" "$PROJECT_ROOT")
if { [ "$SURFACE_KIND" = "identity" ] || [ "$SURFACE_KIND" = "all" ]; } && [ -n "$IDENTITY_DRIFT_ROWS" ]; then
  while IFS=$'\t' read -r i_source i_vsource i_type i_filename i_scope_type i_scope_paths; do
    [ -z "$i_type" ] && continue
    [ -z "$i_filename" ] && continue

    # FR-155: identity-surface project-scope filter (mirrors the skills drift
    # filter and the compile identity-loop filter). Silent skip — a scoped
    # entry that does not apply to the current root is NOT drift; gates
    # TOTAL++ so the summary count is filter-aware.
    if [ "$i_scope_type" = "project" ]; then
      project_root_real="$(realpath "$PROJECT_ROOT" 2>/dev/null || echo "$PROJECT_ROOT")"
      i_matched=0
      if [ -n "$i_scope_paths" ] && [ "$i_scope_paths" != "-" ]; then
        IFS=',' read -ra i_scope_paths_arr <<< "$i_scope_paths"
        for sp in "${i_scope_paths_arr[@]}"; do
          [ -z "$sp" ] && continue
          case "$sp" in
            "~"/*) sp_abs="$HOME/${sp#"~/"}" ;;
            /*)    sp_abs="$sp" ;;
            *)     sp_abs="$PROJECT_ROOT/$sp" ;;
          esac
          sp_real="$(realpath "$sp_abs" 2>/dev/null || echo "$sp_abs")"
          if [ "$sp_real" = "$project_root_real" ]; then
            i_matched=1
            break
          fi
        done
      fi
      if [ "$i_matched" -eq 0 ]; then
        continue
      fi
    fi

    TOTAL=$((TOTAL + 1))

    # Canonical template (3-case; `-` → brain-mirrored default) — mirrors
    # compile_harnesses.sh identity pass byte-for-byte.
    if [ -n "$i_source" ] && [ "$i_source" != "-" ]; then
      case "$i_source" in
        "~"/*) tmpl_abs="$HOME/${i_source#"~/"}" ;;
        /*)    tmpl_abs="$i_source" ;;
        *)     tmpl_abs="$PROJECT_ROOT/$i_source" ;;
      esac
    else
      tmpl_abs="$BRAIN_DIR/core/templates/identity.tmpl"
    fi

    # {{IGRIS_VERSION}} source (3-case; `-` → read_identity_version default).
    vsrc_abs=""
    if [ -n "$i_vsource" ] && [ "$i_vsource" != "-" ]; then
      case "$i_vsource" in
        "~"/*) vsrc_abs="$HOME/${i_vsource#"~/"}" ;;
        /*)    vsrc_abs="$i_vsource" ;;
        *)     vsrc_abs="$PROJECT_ROOT/$i_vsource" ;;
      esac
    fi
    id_version=$(read_identity_version "$vsrc_abs")

    # Output identity file (3-case).
    case "$i_filename" in
      "~"/*) out_abs="$HOME/${i_filename#"~/"}" ;;
      /*)    out_abs="$i_filename" ;;
      *)     out_abs="$PROJECT_ROOT/$i_filename" ;;
    esac

    verify_identity_file_drift "$i_type" "$out_abs" "$tmpl_abs" "$id_version"
  done <<< "$IDENTITY_DRIFT_ROWS"
fi

# ---------------------------------------------------------------------------
# FR-180 (D7 - Option B): event-hook drift pass, line-paired with the compile
# hook pass (§18.1 compile/drift PAIRING — same flattened rows, not a shape
# parity). Flattens the SAME (hook,target) rows via flatten_hook_rows
# (target_kind="all" — drift checks both harness targets per block). Hook drift
# is PRESENCE-BASED, NOT a byte-shape comparison: for claude it reads the
# project's .claude/settings.json and asserts the hook command PATH is present
# under its event array (MATCH) or absent (MISSING) via verify_hook_entry_present
# — there is no bash hook-shaper twin (unlike identity's normalize_identity_shape)
# because the hook is identified by its command path, not its full byte-shape.
# For opencode it asserts the FR-104 plugin exists (covered → MATCH; absent →
# MISSING). Honors --filter (S1) so the scoped verify checks only the added hook.
# ---------------------------------------------------------------------------
HOOK_DRIFT_ROWS=$(flatten_hook_rows "$MERGED_MANIFEST" "$CORE_SURFACES" "all" "$PROJECT_ROOT")
if { [ "$SURFACE_KIND" = "hook" ] || [ "$SURFACE_KIND" = "all" ]; } && [ -n "$HOOK_DRIFT_ROWS" ]; then
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

if [ "$TOTAL" -eq 0 ]; then
  echo "No agent/skills/mcp/identity/hook targets matched (filter='$FILTER')." >&2
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

if [ "$DRIFT" -gt 0 ]; then
  exit 1
fi
exit 0
