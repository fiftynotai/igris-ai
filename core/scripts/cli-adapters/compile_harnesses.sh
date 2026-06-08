#!/bin/bash

# Description: Orchestrate harness regeneration. Reads harness-manifest.json
#              and, for each agent/target, emits the matching per-harness
#              projection: claude → atomic symlink to registry-resident
#              harness.claude.md (FR-152); gemini → hard link to
#              harness.gemini.md (TD-208); codex → atomic symlink to
#              harness.codex.toml (FR-159 — TS `assembleCodexHarness` vendor-
#              side, bash `assemble_codex_harness_into_registry` compile-side
#              fallback for core agents). See L-519 §18.1 (compile/drift-verify
#              pairing).
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
#   --target claude|codex|gemini|opencode|all - Restrict to one target type.
#                            Default: all. Applies to agent targets, skills-
#                            surface targets (FR-137), and MCP targets (FR-164).
#                            opencode is first-class for agents + skills (FR-171).
#   --surface agents|skills|all - Restrict to one projection surface (FR-137).
#                            Default: all. `agents` = the per-agent harnesses;
#                            `skills` = the surfaces.skills projection.
# Dependencies: python3, _common.sh (auto-located from script dir)
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

# FR-164: how the MCP pass invokes the TS projector (`igris registry
# project-mcp`). The merge engine (mergeJsonConfig/mergeTomlConfig) lives in the
# built CLI — bash NEVER re-implements it (§18.1). Resolution order:
#   1. $IGRIS_CLI — a full command string (e.g. "node /repo/cli/dist/index.js").
#      The bats seam sets this so the suite runs against the freshly-built CLI
#      without depending on a globally-linked `igris`. (L-552: rebuild first.)
#   2. the `igris` binary on PATH (the normal `igris harness compile` flow).
# Stored as an ARRAY so a multi-word $IGRIS_CLI ("node /path/index.js") splits
# correctly without eval. Empty array → fall back to the `igris` binary.
IGRIS_CLI_CMD=()
if [ -n "${IGRIS_CLI:-}" ]; then
  # Word-split the override on whitespace (it is a trusted operator/test seam).
  read -ra IGRIS_CLI_CMD <<< "$IGRIS_CLI"
else
  IGRIS_CLI_CMD=(igris)
fi

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
# emit_md_hardlink <link_path> <target>
#
# TD-208: install a HARD LINK at $link_path pointing at the same inode as
# $target. The hard link IS the file from the kernel's perspective — same
# inode, same bytes-on-disk, nlink increments. Gemini subagent loaders do NOT
# follow symbolic links (verified live 2026-06-01) but DO follow hard links.
# Hard link preserves L-516 registry-canonical: the registry file remains THE
# single physical home; the target just adds a directory entry.
#
# IMPORTANT — atomicity model differs from atomic_symlink:
#   - Symlinks support temp+rename for atomic repoint.
#   - Hard links do NOT — `ln` itself is atomic, but a stale entry must be
#     unlinked first. The window between rm and ln is acceptable because the
#     consumer (Gemini loader) reads on-demand at subagent invocation, not
#     during compile.
#
# Re-vendor invalidates hard links: vendorAgentTreeAtomic in cli/src/verbs/
# registry.ts uses temp-file + rename for the registry-resident
# harness.gemini.md, which assigns a NEW inode. The OLD hard link at
# $link_path now points at an orphaned inode and must be removed BEFORE `ln`
# re-shares the new one. The `rm -f` here handles that case.
#
# Precondition: $target exists as a regular file in the registry (assembled
# by assemble_agent_harness_into_registry immediately prior).
# Postcondition: stat -f %i "$link_path" == stat -f %i "$target" AND
# stat -f %l "$target" >= 2.
# ---------------------------------------------------------------------------
emit_md_hardlink() {
  local link_path="$1"
  local target="$2"
  mkdir -p "$(dirname "$link_path")"
  rm -f "$link_path"
  ln "$target" "$link_path"
}

# ---------------------------------------------------------------------------
# resolve_skill_link_path <out_abs> <skill_name>
#
# TD-218 (Option C): compute the per-skill symlink link_path with a de-dup
# guard. The contract is that the target `path` (→ out_abs) is the PARENT
# skills dir, and the loop appends `/<skill_name>`. A LEGACY/hand-edited
# manifest may carry a per-skill `path` that already ends in `/<skill_name>`
# (e.g. `~/.agents/skills/content-pipeline`); naively appending would
# double-nest to `<out_abs>/<skill_name>/<skill_name>/SKILL.md` (depth-2),
# which native loaders (depth-1 scan) never discover. When out_abs already
# terminates in <skill_name>, treat it as the link target itself and do NOT
# append — so EVERY registry skill resolves depth-1 even with a malformed
# manifest. Core blocks (out_abs basename = `skills`) never trigger this.
# Echoes the resolved link_path on stdout. See TD-218, L-519 §18.1
# (compile/drift MUST resolve link_path identically).
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
    # TD-209: append to the global collector for the batched summary block.
    REFUSE_TARGETS+=("$link_path")
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
# opencode_at_target <skill_md>
#
# FR-171: compute the `@file` directive target for a skill's canonical SKILL.md.
# The wrapper loads the ACTUAL canonical the compile walked (NOT a hardcoded
# core path — personal/registry-vendored skills live under
# ~/.igris/registry/skills/, core skills under ~/.igris/core/skills/). Emits a
# `~`-prefixed path when the SKILL.md is under $HOME (portable + matches how
# OpenCode resolved `@~/...` in the §0.2 probe), else the absolute path.
# Echoes `@<path>` on stdout. Shared by the compile emit + drift verify so the
# expected `@`-target is computed identically (L-519 §18.1).
# ---------------------------------------------------------------------------
opencode_at_target() {
  local skill_md="$1"
  case "$skill_md" in
    "$HOME"/*) printf '@~/%s\n' "${skill_md#"$HOME"/}" ;;
    *)         printf '@%s\n' "$skill_md" ;;
  esac
}

# ---------------------------------------------------------------------------
# opencode_command_wrapper_body <skill_md>
#
# FR-171: derive the deterministic body of an OpenCode command wrapper from a
# canonical SKILL.md. Option A (thin wrappers): the wrapper does NOT copy the
# skill content — it loads the canonical SKILL.md at invoke time via OpenCode's
# `@file` directive (verified live: opencode stores `@<path>` in the command
# `template` and resolves it on invocation), plus `$ARGUMENTS`. Single source
# of truth stays the canonical SKILL.md (no edit-drift; only ADD/REMOVE drift).
#
# The wrapper frontmatter carries:
#   description: <from the skill's SKILL.md frontmatter `description:`, or a
#                fallback naming the skill if absent>
#   agent: build   (the OpenCode primary agent that runs the command)
#   subtask: true  (run as a subtask so the command body loads in a sub-context)
#
# Emits the FULL wrapper text (frontmatter + body) on stdout. The first line of
# the file is a generated-marker comment so the drift verdict can confirm the
# wrapper is OUR artifact (refuse-to-clobber a hand-authored command). Mirrors
# the TS marker discipline (assembleCodexHarness). Deterministic — same SKILL.md
# → same bytes (idempotent re-emit).
# ---------------------------------------------------------------------------
OPENCODE_COMMAND_MARKER="<!-- Generated by igris harness compile (FR-171 opencode/command) — edit the canonical SKILL.md, not this wrapper -->"

opencode_command_wrapper_body() {
  local skill_md="$1"
  local skill_name
  skill_name="$(basename "$(dirname "$skill_md")")"
  local at_target
  at_target="$(opencode_at_target "$skill_md")"
  # Extract the skill's `description:` from its SKILL.md frontmatter (first
  # `description:` line inside the leading `---` block). python3 keeps the
  # parse robust (quoted scalars, colons-in-value). Falls back to a stable
  # default when absent so the wrapper always has a description.
  python3 - "$skill_md" "$skill_name" "$OPENCODE_COMMAND_MARKER" "$at_target" <<'PY'
import sys

skill_md = sys.argv[1]
skill_name = sys.argv[2]
marker = sys.argv[3]
at_target = sys.argv[4]

description = ""
try:
    with open(skill_md, "r", encoding="utf-8") as fh:
        text = fh.read()
except OSError:
    text = ""

# Parse the leading `---\n...\n---` frontmatter block only.
lines = text.split("\n")
if lines and lines[0].strip() == "---":
    for ln in lines[1:]:
        if ln.strip() == "---":
            break
        if ln.startswith("description:"):
            val = ln[len("description:"):].strip()
            # Strip a single pair of surrounding quotes if present.
            if len(val) >= 2 and (
                (val[0] == '"' and val[-1] == '"')
                or (val[0] == "'" and val[-1] == "'")
            ):
                val = val[1:-1]
            description = val
            break

if not description:
    description = "Igris " + skill_name + " skill"

# Deterministic wrapper. The `@<path>` directive (computed by opencode_at_target
# from the ACTUAL canonical SKILL.md the compile walked) is honored by OpenCode
# at invoke time (probed live, FR-171 §0.2). $ARGUMENTS forwards the operator's
# command-line args into the loaded skill context.
out = []
out.append(marker)
out.append("---")
out.append("description: " + description)
out.append("agent: build")
out.append("subtask: true")
out.append("---")
out.append(at_target)
out.append("")
out.append("$ARGUMENTS")
out.append("")
sys.stdout.write("\n".join(out))
PY
}

# ---------------------------------------------------------------------------
# emit_opencode_command_wrapper <link_path> <skill_md>
#
# FR-171 Option A: write a thin OpenCode command wrapper at <link_path> (a
# `<command-dir>/<name>.md` file) that loads the canonical SKILL.md via the
# `@file` directive. 3-case dispatch parallel to emit_skill_symlink:
#   - regular file at link_path that is NOT our generated wrapper → ERROR +
#     return 1 (refuse-to-clobber a hand-authored command). Detect by probing
#     the first line for OPENCODE_COMMAND_MARKER.
#   - link_path is a symlink → ERROR + return 1 (a command target should be a
#     real file; a symlink here is an unexpected legacy/foreign shape).
#   - our generated wrapper already present with identical bytes → silent no-op.
#   - our generated wrapper present but stale, or nothing there → atomic
#     temp+rename write + log.
# Caller owns rc + SUMMARY bookkeeping. See L-519 §18.1, L-515.
# ---------------------------------------------------------------------------
emit_opencode_command_wrapper() {
  local link_path="$1"
  local skill_md="$2"

  # Refuse to clobber a symlink (foreign/legacy shape — commands are real files).
  if [ -L "$link_path" ]; then
    echo "[opencode/command/$(basename "$link_path")] ERROR — refuse to clobber symlink at $link_path (an opencode command wrapper is a real file, not a symlink — remove manually)" >&2
    REFUSE_TARGETS+=("$link_path")
    return 1
  fi

  local desired
  desired="$(opencode_command_wrapper_body "$skill_md")"

  if [ -e "$link_path" ]; then
    # Real file present — must be OUR generated wrapper (marker on line 1).
    local first_line
    first_line="$(head -n 1 "$link_path" 2>/dev/null || true)"
    if [ "$first_line" != "$OPENCODE_COMMAND_MARKER" ]; then
      echo "[opencode/command/$(basename "$link_path")] ERROR — refuse to clobber non-generated file at $link_path (no FR-171 generated-marker on line 1 — remove manually if it should be a generated command wrapper)" >&2
      REFUSE_TARGETS+=("$link_path")
      return 1
    fi
    # Our wrapper — idempotent compare.
    local current
    current="$(cat "$link_path" 2>/dev/null || true)"
    if [ "$current" = "$desired" ]; then
      return 0  # already correct — silent no-op
    fi
    mkdir -p "$(dirname "$link_path")"
    local tmp="$link_path.tmp-$$"
    printf '%s' "$desired" > "$tmp"
    mv "$tmp" "$link_path"
    echo "updating opencode command wrapper: $link_path"
    return 0
  fi

  # Nothing there — create.
  mkdir -p "$(dirname "$link_path")"
  local tmp="$link_path.tmp-$$"
  printf '%s' "$desired" > "$tmp"
  mv "$tmp" "$link_path"
  echo "creating opencode command wrapper: $link_path"
  return 0
}

# ---------------------------------------------------------------------------
# assemble_agent_harness_into_registry <harness_label> <name> <canon_abs>
#                                      <exc_abs> <out_dir>
#
# FR-152 / FR-158 α-assembly (compile-side fallback). Materializes
# `<out_dir>/harness.<harness_label>.md` = `---\n<frontmatter>\n---\n\n<body>`
# for the given harness ("claude" or "gemini"). Symlinks at compile time
# resolve to this registry-resident file.
#
# Frontmatter resolution preference per harness:
#   claude:
#     1. `<out_dir>/frontmatter.claude.md`        (FR-151/FR-158 vendor-side sidecar — personal agent),
#     2. `<dirname canon_abs>/frontmatter.claude.md` (FR-151/FR-158 in-place sidecar),
#     3. inline frontmatter extracted from `canon_abs` (TD-195 fallback — core
#        agents whose split hasn't landed).
#   gemini:
#     1. `<out_dir>/frontmatter.gemini.md`        (operator-authored override — honored verbatim),
#     2. `<dirname canon_abs>/frontmatter.gemini.md` (in-place gemini override),
#     3. FALLBACK to the Claude resolution chain, then AUTO-TRANSLATE
#        Claude-shape → Gemini-shape (FR-158 retry 1 regression fix). Brings
#        the bash compile path to parity with TS `assembleGeminiHarness`:
#        translates `tools:` via CLAUDE_TO_GEMINI_TOOLS, injects `kind: local`
#        (unless operator-provided), drops `model:/temperature:/max_turns:`
#        per FR-158 plan §4.1 (Gemini uses defaults; operators override via
#        `frontmatter.gemini.md`). Before this fix, `igris harness compile`
#        clobbered the TS-produced Gemini-shape `harness.gemini.md` back to
#        Claude-shape, silently re-breaking Gemini's `invoke_agent`.
#
# Body is `strip_frontmatter "$canon_abs"`. When `<exc_abs>` is non-empty
# the FR-144 / TD-193 body-exception is applied at the unique anchor line
# (same JSON for both harness labels — Decision 3).
# Atomic temp + mv. Idempotent — same inputs → same bytes. See L-519, FR-158.
# ---------------------------------------------------------------------------
assemble_agent_harness_into_registry() {
  local harness_label="$1"
  local name="$2"
  local canon_abs="$3"
  local exc_abs="$4"
  local out_dir="$5"

  mkdir -p "$out_dir"

  # FR-158: pick the sidecar basename for this harness label, then fall back
  # to the Claude basename so a Gemini compile against a sidecar-less core
  # agent still produces output. For Gemini, the fallback content is then
  # auto-translated below (matches TS `assembleGeminiHarness`).
  local primary_sidecar="frontmatter.${harness_label}.md"
  local fallback_sidecar="frontmatter.claude.md"

  local fm_text=""
  # Track whether the resolved frontmatter came from the FALLBACK Claude
  # sidecar / inline extract (not the primary). When harness_label=gemini
  # AND this flag is 1, we auto-translate the Claude-shape fields into
  # Gemini-shape before assembly. The primary `frontmatter.gemini.md` is
  # honored verbatim (operator override), so the flag stays 0 in that case.
  local fm_is_fallback=0
  if [ -f "$out_dir/$primary_sidecar" ]; then
    fm_text=$(parse_frontmatter "$out_dir/$primary_sidecar" || cat "$out_dir/$primary_sidecar")
  elif [ -f "$(dirname "$canon_abs")/$primary_sidecar" ]; then
    fm_text=$(parse_frontmatter "$(dirname "$canon_abs")/$primary_sidecar" \
              || cat "$(dirname "$canon_abs")/$primary_sidecar")
  elif [ -f "$out_dir/$fallback_sidecar" ]; then
    fm_text=$(parse_frontmatter "$out_dir/$fallback_sidecar" || cat "$out_dir/$fallback_sidecar")
    fm_is_fallback=1
  elif [ -f "$(dirname "$canon_abs")/$fallback_sidecar" ]; then
    fm_text=$(parse_frontmatter "$(dirname "$canon_abs")/$fallback_sidecar" \
              || cat "$(dirname "$canon_abs")/$fallback_sidecar")
    fm_is_fallback=1
  else
    # TD-195 fallback: extract inline frontmatter from canonical. Falls back to
    # an empty fields block when there's no inline frontmatter either (matches
    # pre-FR-152 lenient codex behavior; the assembled harness will have an
    # empty `---\n---\n` block, which is harmless).
    fm_text=$(parse_frontmatter "$canon_abs" || echo "")
    fm_is_fallback=1
  fi

  # FR-158 retry 1: when emitting the Gemini harness AND the frontmatter was
  # sourced from the Claude fallback (no operator-authored `frontmatter.gemini.md`),
  # auto-translate Claude-shape → Gemini-shape. Mirrors TS
  # `translateClaudeToGeminiFrontmatter` byte-for-byte: 9-mapping tool-name
  # table, `kind: local` injection (unless operator-provided in the source),
  # `model:/temperature:/max_turns:` drop, other fields passthrough,
  # `tools:` output normalized to YAML flow-list. Empty `fm_text` (TD-195
  # empty-extract case) passes through this no-op-friendly translator.
  if [ "$harness_label" = "gemini" ] && [ "$fm_is_fallback" = "1" ]; then
    fm_text=$(python3 - "$fm_text" <<'PY'
import re
import sys

# CLAUDE_TO_GEMINI_TOOLS — mirror of cli/src/verbs/registry.ts's
# CLAUDE_TO_GEMINI_TOOLS record. Keep byte-for-byte in sync.
TOOL_MAP = {
    "Read": "read_file",
    "Write": "write_file",
    "Edit": "edit_file",
    "Bash": "run_shell_command",
    "Grep": "grep_search",
    "Glob": "list_directory",  # imperfect — operator override is the escape hatch
    "Task": "task",
    "WebFetch": "web_fetch",
    "WebSearch": "web_search",
}

# Drop set — Gemini uses defaults; operator override via
# `frontmatter.gemini.md` is the escape hatch.
DROPS = {"model", "temperature", "max_turns"}


def parse_tools_field(value):
    """Mirror of TS `parseToolsField`. Accepts string / CSV / YAML flow-list,
    with or without quotes. Returns a list of bare token strings."""
    trimmed = value.strip()
    if trimmed == "":
        return []
    inner = trimmed
    if inner.startswith("[") and inner.endswith("]"):
        inner = inner[1:-1]
    out = []
    for t in inner.split(","):
        t = t.strip()
        # Strip surrounding single OR double quotes.
        if (t.startswith('"') and t.endswith('"')) or (
            t.startswith("'") and t.endswith("'")
        ):
            t = t[1:-1]
        if t:
            out.append(t)
    return out


def parse_simple_frontmatter_fields(fields):
    """Mirror of TS `parseSimpleFrontmatterFields`. Returns ordered list of
    {key, value} dicts. Skips blank lines and non-`key: value` lines."""
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


fields = sys.argv[1]
parsed = parse_simple_frontmatter_fields(fields)
out_lines = []
kind_emitted = False
for entry in parsed:
    key = entry["key"]
    value = entry["value"]
    if key == "tools":
        tokens = parse_tools_field(value)
        translated = [TOOL_MAP.get(t, t) for t in tokens]
        out_lines.append("tools: [" + ", ".join(translated) + "]")
        continue
    if key == "kind":
        out_lines.append(key + ": " + value)
        kind_emitted = True
        continue
    if key in DROPS:
        continue
    out_lines.append(key + ": " + value)
if not kind_emitted:
    out_lines.append("kind: local")
sys.stdout.write("\n".join(out_lines))
PY
)
  fi

  # FR-171: when emitting the OpenCode harness AND the frontmatter was sourced
  # from the Claude fallback (no operator-authored `frontmatter.opencode.md`),
  # auto-translate Claude-shape → OpenCode-shape. Mirrors TS
  # `translateClaudeToOpencodeFrontmatter` BYTE-FOR-BYTE (§18.1 dual-impl,
  # golden-fixture parity test; L-554): `mode: subagent` lead, drop
  # model/temperature/max_turns/kind, `tools:` as a BOOLEAN MAP (allow-list of
  # mapped natives; WebSearch omitted — no native equivalent), `permission:`
  # MCP grant always emitted. Empty `fm_text` (TD-195 empty-extract case)
  # passes through (still emits mode + permission).
  if [ "$harness_label" = "opencode" ] && [ "$fm_is_fallback" = "1" ]; then
    fm_text=$(python3 - "$fm_text" <<'PY'
import re
import sys

# CLAUDE_TO_OPENCODE_TOOLS — mirror of cli/src/verbs/registry.ts's
# CLAUDE_TO_OPENCODE_TOOLS record. Keep byte-for-byte in sync. 8 direct maps;
# WebSearch OMITTED (no native OpenCode equivalent — do NOT invent a key).
TOOL_MAP = {
    "Read": "read",
    "Write": "write",
    "Edit": "edit",
    "Bash": "bash",
    "Grep": "grep",
    "Glob": "glob",
    "Task": "task",
    "WebFetch": "webfetch",
}

# OPENCODE_MCP_PERMISSIONS — mirror of registry.ts. The igris-brain MCP grant
# (FR-166 server merged into opencode.json). Key shape confirmed live
# (opencode 1.14.22): `mcp__<server>__*`.
MCP_PERMISSIONS = ["mcp__igris-brain__*"]

DROPS = {"model", "temperature", "max_turns"}


def parse_tools_field(value):
    """Mirror of TS `parseToolsField`. Accepts string / CSV / YAML flow-list,
    with or without quotes. Returns a list of bare token strings."""
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
    """Mirror of TS `parseSimpleFrontmatterFields`."""
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


fields = sys.argv[1]
parsed = parse_simple_frontmatter_fields(fields)
out_lines = []
mode_emitted = any(e["key"] == "mode" for e in parsed)
tools_value = None
if not mode_emitted:
    out_lines.append("mode: subagent")
for entry in parsed:
    key = entry["key"]
    value = entry["value"]
    if key == "tools":
        tools_value = value
        continue
    if key in DROPS:
        continue
    if key == "kind":
        continue
    out_lines.append(key + ": " + value)
if tools_value is not None:
    tokens = parse_tools_field(tools_value)
    natives = []
    for t in tokens:
        mapped = TOOL_MAP.get(t)
        if mapped is None:
            continue
        if mapped not in natives:
            natives.append(mapped)
    if natives:
        out_lines.append("tools:")
        for n in natives:
            out_lines.append("  " + n + ": true")
out_lines.append("permission:")
for p in MCP_PERMISSIONS:
    out_lines.append('  "' + p + '": allow')
sys.stdout.write("\n".join(out_lines))
PY
)
  fi

  # Strip a trailing newline from frontmatter; we add our own delimiters.
  fm_text="${fm_text%$'\n'}"

  local body
  body=$(strip_frontmatter "$canon_abs")

  # Atomic assemble: build text via python3 so anchor-application + the
  # `---\n<fm>\n---\n\n<body>` concatenation matches the TS vendor path
  # byte-for-byte (FR-144/TD-193 regression guard).
  local out_path="$out_dir/harness.${harness_label}.md"
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
# assemble_codex_harness_into_registry <name> <canon_abs> <exc_abs> <out_dir>
#
# FR-159: derive `<out_dir>/harness.codex.toml` from the FR-151 Claude-shape
# frontmatter sidecar + canonical body. Byte-equivalent to the retired
# `sync_codex_agents.sh` (modulo the leading marker line). Pairs with the TS
# `assembleCodexHarness` in cli/src/verbs/registry.ts (L-519 cross-impl parity).
#
# Frontmatter resolution chain (mirrors `assemble_agent_harness_into_registry`
# for the Claude side; codex only ever reads the Claude-shape sidecar):
#   1. `<out_dir>/frontmatter.claude.md` (registry-vendored sidecar),
#   2. `<dirname canon_abs>/frontmatter.claude.md` (in-place sidecar),
#   3. TD-195 fallback: extract inline frontmatter from `canon_abs` via
#      parse_frontmatter (empty block if none — preserves pre-FR-152 lenient
#      codex behavior for core agents without a sidecar).
#
# Body is `strip_frontmatter "$canon_abs"`. `<exc_abs>` (body-exception sidecar
# path) is ACCEPTED for signature symmetry with the Claude/Gemini assembler
# but NEVER applied — codex emit deliberately bypasses body-exception per
# FR-159 plan §Decision 3 + TD-193 gate. The drift verdict relies on this
# (post-FR-159 the drift verdict is symlink-realpath, but the registry-side
# expected body is still the plain canonical).
#
# Reads ONLY `description` and `name` from the frontmatter (TOML schema is
# fixed at 3 keys per TD-021; `tools:` / `model:` / `temperature:` / etc.
# are not part of the codex subagent contract).
#
# Atomic emit (mktemp + mv). Idempotent: same inputs → same bytes. See
# L-519, FR-159.
# ---------------------------------------------------------------------------
assemble_codex_harness_into_registry() {
  local name="$1"
  local canon_abs="$2"
  local exc_abs="$3"
  local out_dir="$4"

  # FR-159 Decision 3 + TD-193: body-exception is deliberately ignored for
  # codex (parity with retired `sync_codex_agents.sh`). Bind the unused var
  # so `set -u` doesn't trip if the caller passes empty.
  : "${exc_abs:-}"

  mkdir -p "$out_dir"

  # Frontmatter resolution — Claude-shape sidecar only. The 3 cases mirror
  # the retired `resolve_or_extract_frontmatter` helper but live here so the
  # codex emit path is self-contained.
  local fm_path=""
  local fm_temp=""
  if [ -f "$out_dir/frontmatter.claude.md" ]; then
    fm_path="$out_dir/frontmatter.claude.md"
  elif [ -f "$(dirname "$canon_abs")/frontmatter.claude.md" ]; then
    fm_path="$(dirname "$canon_abs")/frontmatter.claude.md"
  else
    # TD-195 fallback: extract inline frontmatter and wrap in `---\n...\n---\n`
    # so get_skill_field reads it. Empty block is fine — get_skill_field
    # returns "" for any field, mirroring the pre-FR-152 lenient codex behavior.
    local inline_text wrapped
    inline_text="$(parse_frontmatter "$canon_abs" 2>/dev/null || echo "")"
    wrapped="$(mktemp "${TMPDIR:-/tmp}/igris_codex_fm_wrapped.XXXXXX")"
    {
      echo "---"
      if [ -n "$inline_text" ]; then
        printf '%s\n' "$inline_text"
      fi
      echo "---"
    } > "$wrapped"
    fm_path="$wrapped"
    fm_temp="$wrapped"
  fi

  local description
  description=$(get_skill_field "$fm_path" "description")
  if [ -z "$description" ]; then
    echo "Warning: No description found in '$fm_path' — using empty string (codex)" >&2
  fi
  local escaped_desc
  escaped_desc=$(toml_escape_description "$description")

  local body
  body=$(strip_frontmatter "$canon_abs")
  local escaped_body
  escaped_body=$(toml_escape "$body")

  # Resolve the TOML `name`: frontmatter `name:` > basename of out_dir.
  # (No CLI override here — the caller passes the agent name implicitly
  # via the out_dir = `<BRAIN_DIR>/registry/agents/<name>` convention.)
  local agent_name
  agent_name=$(get_skill_field "$fm_path" "name")
  if [ -z "$agent_name" ]; then
    agent_name="$name"
  fi
  local escaped_name
  escaped_name=$(toml_escape_description "$agent_name")

  # Cleanup the inline-extract tempfile if we created one.
  if [ -n "$fm_temp" ]; then
    rm -f "$fm_temp"
  fi

  # Emit TOML atomically. Key order is load-bearing (TD-021 finding #2):
  # description, developer_instructions, name.
  local out_path="$out_dir/harness.codex.toml"
  local tmp="$out_path.tmp-$$"
  local marker="# Generated by igris assembleCodexHarness (FR-159)"

  python3 - "$tmp" "$escaped_desc" "$escaped_body" "$escaped_name" "$marker" <<'PY'
import sys

out_path = sys.argv[1]
description = sys.argv[2]
body = sys.argv[3]
name = sys.argv[4]
marker = sys.argv[5]

toml = marker + "\n"
toml += f'description = "{description}"\n'
toml += 'developer_instructions = """\n'
toml += body
if not toml.endswith("\n"):
    toml += "\n"
toml += '"""\n'
toml += f'name = "{name}"\n'

with open(out_path, "w", encoding="utf-8") as fh:
    fh.write(toml)
PY
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$tmp"
    return $rc
  fi
  mv "$tmp" "$out_path"
}

# ---------------------------------------------------------------------------
# compile_md_agent_target <harness_label> <name> <canon_abs> <exc_abs>
#                         <target_abs>
#
# FR-152 / FR-158 / FR-159 / TD-208 per-harness α-projection for claude +
# gemini + codex agent targets. Each harness owns its own registry-resident
# derived file (`harness.claude.md`, `harness.gemini.md`, or
# `harness.codex.toml`); the projection at `<target_abs>` points at the
# matching one. The emit primitive is PER-HARNESS:
#
#   claude → symbolic link (`ln -sf` via atomic_symlink). Claude's subagent
#            loader follows symlinks fine.
#   codex  → symbolic link (`ln -sf` via atomic_symlink). FR-159: codex's
#            subagent .toml loader follows symlinks (sibling to its skill
#            loader, which already follows them per FR-157 / TD-202 verified
#            live). Output file is `harness.codex.toml` (TOML, not Markdown).
#   opencode → symbolic link (`ln -sf` via atomic_symlink). FR-171: OpenCode's
#            agent loader follows symbolic links (verified live 2026-06-08,
#            opencode 1.14.22). Output file is `harness.opencode.md` (Markdown,
#            OpenCode-shaped frontmatter). Shares the claude symlink branch.
#   gemini → HARD LINK (`ln` via emit_md_hardlink). TD-208: Gemini's subagent
#            loader does NOT follow symbolic links (verified live 2026-06-01)
#            but DOES follow hard links. Hard link preserves L-516
#            registry-canonical: same inode = same bytes-on-disk = registry
#            remains the single physical home.
#
# Claude / Codex branch — 3-case symlink dispatch (FR-152 / FR-159):
#   Case A — target absent → assemble + create symlink → harness.<label>.<ext>.
#   Case B — target IS a symlink → if it resolves to the registry
#            harness.<label>.<ext>, silent no-op; else atomically repoint + log.
#   Case C — target IS a regular file → HARD ERROR (refuse-to-clobber).
#
# Gemini branch — TD-208 contract (we own this path; idempotent re-emit):
#   - target absent → emit hard link + log "creating".
#   - target IS a symlink (legacy pre-TD-208 state) → migrate to hard link +
#     log "migrating legacy ... to hard link".
#   - target IS a regular file with inode equal to harness.gemini.md →
#     already correctly hard-linked; silent no-op.
#   - target IS a regular file with mismatching inode → re-emit + log
#     "re-establishing". This SUPERSEDES the FR-152 refuse-to-clobber
#     posture: a hard link IS a real file (non-symlink), so refusing any
#     real file would make Gemini refuse to overwrite its own output. The
#     compile pipeline is the only legitimate writer of this path.
#
# FR-159 codex assembly: codex uses a separate assembler
# `assemble_codex_harness_into_registry` that emits a 3-key TOML document
# (description, developer_instructions, name) byte-for-byte equivalent to
# the retired `sync_codex_agents.sh`. Body-exception is NOT applied for
# codex (parity with retired script; see L-519 §18.1 + TD-193).
#
# See L-519 §18.1 (compile/drift-verify pairing). Body-exception is applied
# at assembly time, not at emit time (claude/gemini only).
# ---------------------------------------------------------------------------
compile_md_agent_target() {
  local harness_label="$1"
  local name="$2"
  local canon_abs="$3"
  local exc_abs="$4"
  local target_abs="$5"

  # FR-159: per-harness extension + assembler selection. codex emits TOML
  # via a separate assembler; claude/gemini share the .md assembler.
  local harness_ext="md"
  if [ "$harness_label" = "codex" ]; then
    harness_ext="toml"
  fi

  local registry_agent_dir="$BRAIN_DIR/registry/agents/$name"
  if [ "$harness_label" = "codex" ]; then
    if ! assemble_codex_harness_into_registry "$name" "$canon_abs" \
                                              "$exc_abs" \
                                              "$registry_agent_dir"; then
      return 1
    fi
  else
    if ! assemble_agent_harness_into_registry "$harness_label" "$name" \
                                              "$canon_abs" "$exc_abs" \
                                              "$registry_agent_dir"; then
      return 1
    fi
  fi
  local harness_target="$registry_agent_dir/harness.${harness_label}.${harness_ext}"

  # TD-208: gemini emits via hard link (Gemini loader does not follow
  # symlinks). The harness IS a real file (non-symlink), so "real file at
  # target" can mean "already correctly hard-linked" — distinguished by
  # inode equality against harness.gemini.md.
  if [ "$harness_label" = "gemini" ]; then
    if [ -L "$target_abs" ]; then
      # Legacy symlink left over from pre-TD-208 compile — migrate to hard link.
      local current_target
      current_target=$(readlink "$target_abs" 2>/dev/null || true)
      emit_md_hardlink "$target_abs" "$harness_target"
      echo "migrating legacy gemini symlink to hard link: $target_abs → $harness_target (was symlink: $current_target)"
      return 0
    fi
    if [ -e "$target_abs" ]; then
      # Regular file (or other non-symlink shape) at target — distinguish by
      # inode: matching inode = correctly hard-linked (silent no-op);
      # mismatching = stale orphan from re-vendor / operator `cp` / hand-edit
      # → re-emit. We OWN this path; re-emit is the contract.
      local tgt_inode src_inode
      tgt_inode=$(stat -f %i "$target_abs" 2>/dev/null || echo "")
      src_inode=$(stat -f %i "$harness_target" 2>/dev/null || echo "")
      if [ -n "$tgt_inode" ] && [ "$tgt_inode" = "$src_inode" ]; then
        return 0  # already correctly hard-linked — silent no-op
      fi
      emit_md_hardlink "$target_abs" "$harness_target"
      echo "re-establishing gemini hard link: $target_abs → $harness_target"
      return 0
    fi
    # Nothing there — create.
    emit_md_hardlink "$target_abs" "$harness_target"
    echo "creating gemini hard link: $target_abs → $harness_target"
    return 0
  fi

  # claude + codex + opencode branch (FR-159 / FR-171) — symbolic link
  # projection (3-case dispatch unchanged from FR-152; codex shares it because
  # codex's subagent .toml loader follows symlinks per FR-157 / TD-202;
  # opencode shares it because OpenCode's agent loader follows symlinks too,
  # verified live FR-171). harness_ext stays `md` for claude + opencode.

  # Case C: real file, NOT a symlink → refuse-to-clobber. The FR-149 back-compat
  # via the legacy body-refresh adapter is retired by FR-152; the operator
  # must remove the file manually before compile re-creates a registry-anchored
  # symlink.
  if [ -f "$target_abs" ] && [ ! -L "$target_abs" ]; then
    echo "[$name/$harness_label] ERROR — refuse to clobber non-symlink target: $target_abs (remove manually if it should be a registry-anchored symlink)" >&2
    # TD-209: append to the global collector for the batched summary block.
    REFUSE_TARGETS+=("$target_abs")
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
  # TD-209: append to the global collector for the batched summary block.
  REFUSE_TARGETS+=("$target_abs")
  return 1
}

# ---------------------------------------------------------------------------
# usage — prints usage and exits with code 2.
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 --project-root <dir> [--manifest <path>] [--overlay <path>]" >&2
  echo "                          [--filter <name-glob>] [--target claude|codex|gemini|opencode|all]" >&2
  echo "                          [--surface agents|skills|mcp|all]" >&2
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

# FR-164: --target accepts `opencode` (the 4th MCP-only harness). It applies to
# the MCP pass row filter; the agent + skills passes silently match nothing for
# opencode (no agent/skill targets declare it), which is correct.
case "$TARGET_KIND" in
  claude|codex|gemini|opencode|all) : ;;
  *)
    echo "Error: --target must be claude, codex, gemini, opencode, or all (got '$TARGET_KIND')" >&2
    usage
    ;;
esac

# FR-164: --surface accepts `mcp` (the MCP projection pass).
case "$SURFACE_KIND" in
  agents|skills|mcp|all) : ;;
  *)
    echo "Error: --surface must be agents, skills, mcp, or all (got '$SURFACE_KIND')" >&2
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
# FR-164: the agent pass runs only for agents/all (skipped for skills and mcp).
if [ "$SURFACE_KIND" = "skills" ] || [ "$SURFACE_KIND" = "mcp" ]; then
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
    # FR-155: propagate `scope` as the FINAL columns (appended AFTER layer so
    # the FR-154 read shape is back-compat — a downstream IFS=$'\t' read with
    # the old column list still gets the right values up through `layer`).
    # Absent scope → "global" (default per the schema). For type=project, the
    # paths array is comma-joined; the `-` sentinel preserves column count
    # when the array is empty (which `type=global` enforces by structural
    # validation, but defensive nonetheless to keep the read shape stable
    # against any future scope kind that legitimately omits paths). Mirrors
    # the body_exception `-`-sentinel discipline a few lines up.
    scope = agent.get("scope") or {}
    scope_type = scope.get("type") or "global"
    scope_paths_list = scope.get("paths") or []
    scope_paths_csv = ",".join(scope_paths_list) if scope_paths_list else "-"
    for target in agent.get("targets", []):
        ttype = target["type"]
        if target_kind != "all" and ttype != target_kind:
            continue
        row = "\t".join([
            name, versioned, canon_dir, canon_ref, body_exc,
            ttype, target["path"], layer, scope_type, scope_paths_csv,
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
# TD-209: batched refuse-to-clobber collector. Per-target functions
# (emit_skill_symlink + compile_md_agent_target Cases C and "other-shape")
# append the offending path here; the post-loop summary emits ONE block
# instead of N per-file ERROR lines. Global namespace (no `local -n`
# nameref) — required for bash 3.2 (/bin/bash on macOS). Writers MUST
# avoid `local REFUSE_TARGETS` shadowing.
REFUSE_TARGETS=()
# FR-152: TMPFILES_TO_CLEAN was initialized above the merge step; the EXIT trap
# already references it (loop-pushed inline tempfiles get cleaned on exit).

if [ -n "$WORK_ROWS" ]; then
while IFS=$'\t' read -r name versioned canon_dir canon_ref body_exc ttype target_path layer scope_type scope_paths; do
  [ -z "$name" ] && continue

  # FR-155: project-scope filter. A `scope.type=project` entry emits only when
  # the current --project-root realpath EQUALS the realpath of at least one
  # path in scope.paths[]. Both sides are realpath'd so macOS `/tmp` (→
  # `/private/tmp`), `/var` (→ `/private/var`), and similar symlink-resolved
  # TMPDIR prefixes do NOT produce false skips. A non-match is a SILENT skip
  # — neither counted in TOTAL nor emitted as DRIFTED/MISSING. Project-scoped
  # entries that don't apply to the current root are NOT drift; they are
  # correctly filtered. Filter MUST run BEFORE the TOTAL++ increment so the
  # summary line counts only the rows that survived the filter.
  if [ "$scope_type" = "project" ]; then
    project_root_real="$(realpath "$PROJECT_ROOT" 2>/dev/null || echo "$PROJECT_ROOT")"
    matched=0
    if [ -n "$scope_paths" ] && [ "$scope_paths" != "-" ]; then
      IFS=',' read -ra scope_paths_arr <<< "$scope_paths"
      for sp in "${scope_paths_arr[@]}"; do
        [ -z "$sp" ] && continue
        # Mirrors the FR-154 3-case target.path resolver: `~/...` → $HOME,
        # `/abs/...` → verbatim, else project-relative. The CLI realpath's
        # `--project` at WRITE time so paths[] is canonical absolute in
        # practice; the relative arm is tolerated for hand-edited manifests.
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
      # FR-152 / FR-158: registry-anchored symlink → assembled
      # harness.claude.md (Case A/B); real-file target → refuse-to-clobber
      # (Case C retired). See L-519.
      compile_md_agent_target "claude" "$name" "$canon_abs" "$exc_abs" \
                              "$target_abs" || rc=$?
      ;;
    gemini)
      # FR-152 / FR-158: first-class gemini agent target. Per-harness
      # α-projection — gemini symlink resolves to harness.gemini.md (own
      # derived output), allowing Gemini-shape frontmatter (kind: local,
      # snake_case tool names) via auto-translate or operator-authored
      # frontmatter.gemini.md override.
      compile_md_agent_target "gemini" "$name" "$canon_abs" "$exc_abs" \
                              "$target_abs" || rc=$?
      ;;
    codex)
      # FR-159: codex now α-projects from the registry-resident
      # harness.codex.toml (assembled by TS assembleCodexHarness at vendor
      # time, or by compile-side assemble_codex_harness_into_registry as
      # a fallback for core agents). Target is a symlink, parallel to claude.
      compile_md_agent_target "codex" "$name" "$canon_abs" "$exc_abs" \
                              "$target_abs" || rc=$?
      ;;
    opencode)
      # FR-171: first-class opencode agent target. Per-harness α-projection —
      # opencode symlink resolves to harness.opencode.md (own derived output,
      # OpenCode-shaped: `mode: subagent`, boolean `tools:` map, `permission:`
      # MCP grant) via auto-translate or operator-authored
      # frontmatter.opencode.md override. OpenCode's loader follows symlinks
      # (verified live), so it shares the claude symlink primitive.
      compile_md_agent_target "opencode" "$name" "$canon_abs" "$exc_abs" \
                              "$target_abs" || rc=$?
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
# Skipped entirely when --surface agents or --surface mcp (FR-164).
# ---------------------------------------------------------------------------
if [ "$SURFACE_KIND" = "skills" ] || [ "$SURFACE_KIND" = "all" ]; then
  # Flatten skills targets from both sources into rows:
  #   source <TAB> type <TAB> method <TAB> path <TAB> scope_type <TAB> scope_paths
  # `-` is the empty-source / empty-paths sentinel (caller falls back to md_to_*'s
  # default; scope_paths="-" means scope=global so no project-root match needed).
  # FR-155: scope_type+scope_paths appended at the END so any downstream parser
  # reading only the first 4 columns stays back-compat with the pre-FR-155 shape.
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
        # FR-155: emit per-block scope columns. Absent → global default. The
        # comma-joined paths list uses the `-` sentinel when empty (mirrors
        # the body_exception precedent in the agent flatten).
        scope = block.get("scope") or {}
        scope_type = scope.get("type") or "global"
        scope_paths_list = scope.get("paths") or []
        scope_paths_csv = ",".join(scope_paths_list) if scope_paths_list else "-"
        for t in block.get("targets", []) or []:
            ttype = (t or {}).get("type", "")
            if target_kind != "all" and ttype != target_kind:
                continue
            print("\t".join([
                source,
                ttype,
                (t or {}).get("method", ""),
                (t or {}).get("path", ""),
                scope_type,
                scope_paths_csv,
            ]))
PY
)

  if [ -n "$SKILL_ROWS" ]; then
    while IFS=$'\t' read -r s_source s_type s_method s_path s_scope_type s_scope_paths; do
      [ -z "$s_type" ] && continue

      # FR-155: skills surface project-scope filter. Identical posture to the
      # agent-loop filter above — silent skip when scope.type=project and the
      # current --project-root realpath is not in scope.paths[]. Both sides
      # realpath'd for macOS `/tmp` ↔ `/private/tmp` equality. MUST gate the
      # TOTAL++ so a project-scoped non-matching row doesn't pollute the
      # summary count.
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
          while IFS= read -r -d '' skill_md; do
            skill_name="$(basename "$(dirname "$skill_md")")"
            skill_dir="$(dirname "$skill_md")"
            link_path="$(resolve_skill_link_path "$out_abs" "$skill_name")"
            # TD-218: create the LINK's parent dir (not out_abs). For a parent
            # target.path this is out_abs itself; for a de-dup'd per-skill path
            # (link_path == out_abs) it is out_abs's parent — so the link path
            # is NOT pre-created as a real dir (which would refuse-to-clobber).
            mkdir -p "$(dirname "$link_path")"
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
          while IFS= read -r -d '' skill_md; do
            skill_name="$(basename "$(dirname "$skill_md")")"
            skill_dir="$(dirname "$skill_md")"
            link_path="$(resolve_skill_link_path "$out_abs" "$skill_name")"
            # TD-218: create the LINK's parent dir (not out_abs). For a parent
            # target.path this is out_abs itself; for a de-dup'd per-skill path
            # (link_path == out_abs) it is out_abs's parent — so the link path
            # is NOT pre-created as a real dir (which would refuse-to-clobber).
            mkdir -p "$(dirname "$link_path")"
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
          while IFS= read -r -d '' skill_md; do
            skill_name="$(basename "$(dirname "$skill_md")")"
            skill_dir="$(dirname "$skill_md")"
            link_path="$(resolve_skill_link_path "$out_abs" "$skill_name")"
            # TD-218: create the LINK's parent dir (not out_abs). For a parent
            # target.path this is out_abs itself; for a de-dup'd per-skill path
            # (link_path == out_abs) it is out_abs's parent — so the link path
            # is NOT pre-created as a real dir (which would refuse-to-clobber).
            mkdir -p "$(dirname "$link_path")"
            if ! emit_skill_symlink "gemini" "$link_path" "$skill_dir"; then
              SUMMARY+=("FAIL  skills/$s_type/$skill_name — refuse to clobber non-symlink at $link_path")
              rc=1
              continue
            fi
          done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                     -name 'SKILL.md' -print0 | sort -z)
          ;;
        agents/symlink)
          # FR-157: per-skill registry-anchored symlinks at the cross-CLI shared
          # `~/.agents/skills/` standard (codex+gemini both read this natively).
          # Byte-for-byte mirror of codex/symlink including the D2 absolute-
          # target guard — codex resolves relative-path symlinks from cwd
          # regardless of where the symlink LIVES, so the hazard applies to
          # `~/.agents/skills/` too. See L-519, FR-157.
          conv_root="${src_abs:-$HOME/.igris/core/skills}"
          if [ ! -d "$conv_root" ]; then
            SUMMARY+=("FAIL  skills/$s_type — skills root missing: $conv_root")
            FAIL=$((FAIL + 1))
            continue
          fi
          while IFS= read -r -d '' skill_md; do
            skill_name="$(basename "$(dirname "$skill_md")")"
            skill_dir="$(dirname "$skill_md")"
            link_path="$(resolve_skill_link_path "$out_abs" "$skill_name")"
            # TD-218: create the LINK's parent dir (not out_abs). For a parent
            # target.path this is out_abs itself; for a de-dup'd per-skill path
            # (link_path == out_abs) it is out_abs's parent — so the link path
            # is NOT pre-created as a real dir (which would refuse-to-clobber).
            mkdir -p "$(dirname "$link_path")"
            # FR-157 D2: agents symlink absolute-path enforcement (inherits
            # codex hazard via the cross-CLI `.agents/` consumer chain).
            case "$skill_dir" in
              /*) : ;;
              *)
                echo "[$s_type/skills/$skill_name] ERROR — agents symlink requires absolute target (got relative: $skill_dir). The 'source' field must be absolute, '~'-prefixed, or relative-resolved (compile_harnesses.sh source-resolution should have absolutized this)." >&2
                SUMMARY+=("FAIL  skills/$s_type/$skill_name — agents symlink target not absolute: $skill_dir")
                rc=1
                continue
                ;;
            esac
            if ! emit_skill_symlink "agents" "$link_path" "$skill_dir"; then
              SUMMARY+=("FAIL  skills/$s_type/$skill_name — refuse to clobber non-symlink at $link_path")
              rc=1
              continue
            fi
          done < <(find "$conv_root" -mindepth 2 -maxdepth 2 -type f \
                     -name 'SKILL.md' -print0 | sort -z)
          ;;
        opencode/command)
          # FR-171 Option A: thin command wrappers. For each <name>/SKILL.md
          # under the source root, write a `<out_abs>/<name>.md` command wrapper
          # whose body loads the canonical SKILL.md via OpenCode's `@file`
          # directive (single source of truth stays the canonical SKILL.md — no
          # content copy, no edit-drift). Idempotent (correct wrapper → silent
          # no-op), atomic temp+rename, refuse-to-clobber a non-generated file.
          # NOT a symlink (OpenCode commands are real files). See L-519, FR-171.
          conv_root="${src_abs:-$HOME/.igris/core/skills}"
          if [ ! -d "$conv_root" ]; then
            SUMMARY+=("FAIL  skills/$s_type — skills root missing: $conv_root")
            FAIL=$((FAIL + 1))
            continue
          fi
          # L-515: contain the manifest-controlled out_abs. The wrapper write
          # path must resolve under the OpenCode command dir's parent (the
          # operator-declared target.path) — realpath the parent and reject if
          # the join escapes via `..` traversal. We do not require a fixed root
          # (the command dir is operator-chosen), but we DO reject a per-file
          # path that resolves outside its declared out_abs parent.
          out_parent_real=$(realpath "$(dirname "$out_abs")" 2>/dev/null || echo "")
          while IFS= read -r -d '' skill_md; do
            skill_name="$(basename "$(dirname "$skill_md")")"
            # Command wrapper file is <out_abs>/<name>.md (depth-1; OpenCode
            # scans the command dir non-recursively). resolve_skill_link_path's
            # de-dup guard does not apply (commands are files, not dirs); the
            # path is always out_abs/<name>.md.
            link_path="$out_abs/$skill_name.md"
            mkdir -p "$out_abs"
            # L-515 containment: the resolved parent of link_path must equal
            # the realpath'd out_abs (no `..`-escape via skill_name).
            link_parent_real=$(realpath "$(dirname "$link_path")" 2>/dev/null || echo "")
            out_abs_real=$(realpath "$out_abs" 2>/dev/null || echo "")
            if [ -z "$link_parent_real" ] || [ "$link_parent_real" != "$out_abs_real" ]; then
              echo "[opencode/command/$skill_name] ERROR — wrapper path escapes the declared command dir (resolved parent: $link_parent_real, expected: $out_abs_real)" >&2
              SUMMARY+=("FAIL  skills/$s_type/$skill_name — wrapper path containment violation")
              rc=1
              continue
            fi
            : "$out_parent_real"  # reserved for future stricter root pinning
            if ! emit_opencode_command_wrapper "$link_path" "$skill_md"; then
              SUMMARY+=("FAIL  skills/$s_type/$skill_name — refuse to clobber non-generated wrapper at $link_path")
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

# ---------------------------------------------------------------------------
# FR-164 (FR-160 epic): MCP-server projection pass. For each (mcp-block,target)
# row, dispatch to the TS projector (`igris registry project-mcp`) which builds
# the native per-harness entry and MERGES it into the live harness config via
# the proven mergeJsonConfig/mergeTomlConfig (§18.1: bash NEVER re-implements
# the merge — this pass is a thin driver + accounting). Each invocation writes
# ONE config; we count OK/FAIL per (mcp,target) into the shared accumulators.
#
# SECRET HYGIENE: the row carries the ${VAR} REFERENCE in `canonical_json`, NOT
# a resolved literal. The codex literal is resolved only INSIDE the projector
# (from secrets.env), never in a bash variable that could be `set -x`'d. We
# NEVER echo `canonical_json`. The projector itself prints only the outcome +
# name + harness (no env values).
# ---------------------------------------------------------------------------
if [ "$SURFACE_KIND" = "mcp" ] || [ "$SURFACE_KIND" = "all" ]; then
  MCP_ROWS=$(flatten_mcp_rows "$MERGED_MANIFEST" "$CORE_SURFACES" "$TARGET_KIND" "$PROJECT_ROOT")
  if [ -n "$MCP_ROWS" ]; then
    while IFS=$'\t' read -r m_name m_canon m_type m_enabled m_scope_type m_scope_paths; do
      [ -z "$m_name" ] && continue
      [ -z "$m_type" ] && continue

      # v1 is GLOBAL-ONLY; scope columns are carried for forward-compat but
      # every block is treated as global (no project-scope filter here, unlike
      # skills). m_canon/m_scope_* are intentionally NOT echoed (m_canon holds
      # the ${VAR} ref).
      : "$m_scope_type" "$m_scope_paths"

      TOTAL=$((TOTAL + 1))

      # Dispatch to the TS projector. ONE harness per call. The projector reads
      # the SAME merged manifest (base ++ overlay) via --project-root/--overlay,
      # finds the named block, and writes the native shape atomically. Its
      # stdout/stderr passes through (the projector never prints a secret).
      rc=0
      "${IGRIS_CLI_CMD[@]}" registry project-mcp \
        --name "$m_name" \
        --harness "$m_type" \
        --project-root "$PROJECT_ROOT" \
        ${OVERLAY:+--overlay "$OVERLAY"} || rc=$?

      if [ "$rc" -eq 0 ]; then
        SUMMARY+=("OK    mcp/$m_name/$m_type")
        OK=$((OK + 1))
      else
        # Observable FAIL (L-232): a real exit code + a counted FAIL row, never
        # a silent empty success. The projector already named the failure on
        # stderr (block-not-found / missing-secret VAR name / merge error).
        SUMMARY+=("FAIL  mcp/$m_name/$m_type — projector exited $rc")
        FAIL=$((FAIL + 1))
      fi
    done <<< "$MCP_ROWS"
  fi
fi

if [ "$TOTAL" -eq 0 ]; then
  echo "No agent/skills/mcp targets matched (filter='$FILTER', target='$TARGET_KIND', surface='$SURFACE_KIND')." >&2
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

# TD-209: batched refuse-to-clobber block. Emitted only when at least one
# refuse-to-clobber event was collected. The per-file ERROR lines (inside
# each refusing function) and the per-row FAIL log lines (in $SUMMARY)
# still appear above; this block adds the consolidated view plus a
# copy-pasteable recovery `rm ... && igris harness compile` line. Each
# path is shell-quoted via printf '%q' so paths with spaces / special
# chars survive copy-paste verbatim. Zero-refuse runs produce
# byte-identical output to pre-TD-209 (no header, no recovery line).
# Refuse rows already increment FAIL → existing exit gate below covers
# the contract; this block is purely diagnostic.
if [ "${#REFUSE_TARGETS[@]}" -gt 0 ]; then
  echo ""
  echo "Refuse-to-clobber: ${#REFUSE_TARGETS[@]} non-symlink target(s) blocked compile:"
  for p in "${REFUSE_TARGETS[@]}"; do
    echo "  $p"
  done
  echo ""
  echo "  Recovery — inspect the files above, then run:"
  # Build the quoted path list. printf '%q' is bash-builtin (no fork).
  quoted_paths=""
  for p in "${REFUSE_TARGETS[@]}"; do
    if [ -z "$quoted_paths" ]; then
      quoted_paths="$(printf '%q' "$p")"
    else
      quoted_paths="$quoted_paths $(printf '%q' "$p")"
    fi
  done
  echo "    rm $quoted_paths && igris harness compile"
fi

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
