#!/bin/bash

# Description: Orchestrate harness regeneration. Reads harness-manifest.json
#              and, for each agent/target, emits the matching per-harness
#              projection: claude → atomic symlink to loadout-resident
#              harness.claude.md (FR-152); gemini → hard link to
#              harness.gemini.md (TD-208); codex → atomic symlink to
#              harness.codex.toml (FR-159 — TS `assembleCodexHarness` vendor-
#              side, bash `assemble_codex_harness_into_loadout` compile-side
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
#                            (FR-136 base+overlay seam; FR-139 loadout seam).
#                            Default: auto-discover
#                            <brain>/loadout/harness-manifest.personal.json
#                            if present (absent is the normal case).
#   --filter <name-glob>   - Only process agents whose name matches the glob
#                            (shell case-glob, e.g. 'content-*'). Default: all.
#   --target claude|codex|gemini|opencode|all - Restrict to one target type.
#                            Default: all. Applies to agent targets, skills-
#                            surface targets (FR-137), and MCP targets (FR-164).
#                            opencode is first-class for agents + skills (FR-171).
#   --surface agents|skills|mcp|hook|all - Restrict to one projection
#                            surface (FR-137). Default: all. `agents` = the
#                            per-agent harnesses; `skills` = the
#                            surfaces.skills projection; `mcp` = the
#                            surfaces.mcp_servers config-merge (FR-164);
#                            `hook` = the surfaces.hooks config-merge (FR-180).
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
# lives under <brain>/loadout/ and is OPTIONAL (absent is the normal case).
BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
readonly DEFAULT_OVERLAY="$BRAIN_DIR/loadout/harness-manifest.personal.json"

# FR-164: how the MCP pass invokes the TS projector (`igris loadout
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

# FR-212d Phase 2 (the #832 chokepoint cleared — the 5-harness smoke gate is
# green): the SKILLS engine is now ALWAYS "delegate". The custom inline
# symlink/wrapper loop was DELETED; `project_skills` is a thin shell-out to
# `igris loadout project-skills` (the `skills` CLI). There is NO escape hatch —
# the `IGRIS_SKILLS_ENGINE` env read is gone (operator decision). The helper is
# kept as a constant so the (now unconditional) delegate dispatch + the drift
# sibling read it identically (L-519 §18.1 compile/drift pairing).
igris_skills_engine() {
  echo "delegate"
}

# FR-212d Phase 2: the MCP engine is now ALWAYS "delegate" — `add-mcp` (server
# registration) + the Igris-owned no-prompt grant for the delegated harnesses,
# with antigravity's ENTRY carved out to the custom merger INSIDE the TS
# (`runProjectMcp`, FR-179 config-path mismatch). The custom merger placement for
# the delegated harnesses was DELETED. No escape hatch — the `IGRIS_MCP_ENGINE`
# env read is gone. The helper is kept as a constant for the SUMMARY label +
# parity with the drift sibling's grant-drift invariant (which now always runs).
igris_mcp_engine() {
  echo "delegate"
}

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
# Hard link preserves L-516 loadout-canonical: the loadout file remains THE
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
# loadout.ts uses temp-file + rename for the loadout-resident
# harness.gemini.md, which assigns a NEW inode. The OLD hard link at
# $link_path now points at an orphaned inode and must be removed BEFORE `ln`
# re-shares the new one. The `rm -f` here handles that case.
#
# Precondition: $target exists as a regular file in the loadout (assembled
# by assemble_agent_harness_into_loadout immediately prior).
# Postcondition: file_inode "$link_path" == file_inode "$target" AND
# file_nlink "$target" >= 2 (portable helpers, _common.sh — TD-434).
# ---------------------------------------------------------------------------
emit_md_hardlink() {
  local link_path="$1"
  local target="$2"
  mkdir -p "$(dirname "$link_path")"
  rm -f "$link_path"
  ln "$target" "$link_path"
}

# FR-212d Phase 2: the per-skill symlink/wrapper EMIT helpers
# (resolve_skill_link_path / emit_skill_symlink / opencode_at_target /
# opencode_command_wrapper_body / emit_opencode_command_wrapper) were DELETED
# here — they were the inline custom skills-placement machinery, now fully dead
# after project_skills became a thin `skills` CLI delegate (their only callers
# were the deleted custom loop). `atomic_symlink` (above) is KEPT — the AGENT
# compiler still uses it. The drift sibling (check_harness_drift.sh) DELETED its
# copies too — its custom verify_skills body was likewise retired (verify_skills
# is the `skills` CLI idempotent re-check now), so neither file keeps them.

# ---------------------------------------------------------------------------
# assemble_agent_harness_into_loadout <harness_label> <name> <canon_abs>
#                                      <exc_abs> <out_dir>
#
# FR-152 / FR-158 α-assembly (compile-side fallback). Materializes
# `<out_dir>/harness.<harness_label>.md` = `---\n<frontmatter>\n---\n\n<body>`
# for the given harness ("claude" or "gemini"). Symlinks at compile time
# resolve to this loadout-resident file.
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
assemble_agent_harness_into_loadout() {
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

# CLAUDE_TO_GEMINI_TOOLS — mirror of cli/src/verbs/loadout.ts's
# CLAUDE_TO_GEMINI_TOOLS record. Keep byte-for-byte in sync.
TOOL_MAP = {
    "Read": "read_file",
    "Write": "write_file",
    # TD-229: Gemini's edit tool is `replace` (EDIT_TOOL_NAME), NOT `edit_file`.
    # `edit_file` fails isValidToolName → "tools.N: Invalid tool name".
    "Edit": "replace",
    "Bash": "run_shell_command",
    "Grep": "grep_search",
    "Glob": "list_directory",  # imperfect — operator override is the escape hatch
    "Task": "task",
    "WebFetch": "web_fetch",
    "WebSearch": "web_search",
}

# Drop set — Gemini uses defaults; operator override via
# `frontmatter.gemini.md` is the escape hatch. `memory` (TD-229) is a
# Claude-only key: Gemini's strict subagent schema rejects it with
# "Unrecognized key(s) in object: 'memory'" → the agent fails to load.
# Keep byte-for-byte in sync with the TS DROPS condition in loadout.ts.
DROPS = {"model", "temperature", "max_turns", "memory"}


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
        # TD-229: drop Claude MCP-tool tokens (`mcp__<server>__<tool>`). Gemini's
        # agent schema rejects the double-underscore Claude shape ("Invalid tool
        # name"). MCP tools reach Gemini agents via `mcp_servers` + harness-level
        # MCP registration, NOT the `tools` array. Keep byte-for-byte in sync
        # with the TS translateClaudeToGeminiFrontmatter filter.
        tokens = [t for t in tokens if not t.startswith("mcp__")]
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

# CLAUDE_TO_OPENCODE_TOOLS — mirror of cli/src/verbs/loadout.ts's
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

# OPENCODE_MCP_PERMISSIONS — mirror of loadout.ts. The igris-brain MCP grant
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
# assemble_codex_harness_into_loadout <name> <canon_abs> <exc_abs> <out_dir>
#
# FR-159: derive `<out_dir>/harness.codex.toml` from the FR-151 Claude-shape
# frontmatter sidecar + canonical body. Byte-equivalent to the retired
# `sync_codex_agents.sh` (modulo the leading marker line). Pairs with the TS
# `assembleCodexHarness` in cli/src/verbs/loadout.ts (L-519 cross-impl parity).
#
# Frontmatter resolution chain (mirrors `assemble_agent_harness_into_loadout`
# for the Claude side; codex only ever reads the Claude-shape sidecar):
#   1. `<out_dir>/frontmatter.claude.md` (loadout-vendored sidecar),
#   2. `<dirname canon_abs>/frontmatter.claude.md` (in-place sidecar),
#   3. TD-195 fallback: extract inline frontmatter from `canon_abs` via
#      parse_frontmatter (empty block if none — preserves pre-FR-152 lenient
#      codex behavior for core agents without a sidecar).
#
# Body is `strip_frontmatter "$canon_abs"`. `<exc_abs>` (body-exception sidecar
# path) is ACCEPTED for signature symmetry with the Claude/Gemini assembler
# but NEVER applied — codex emit deliberately bypasses body-exception per
# FR-159 plan §Decision 3 + TD-193 gate. The drift verdict relies on this
# (post-FR-159 the drift verdict is symlink-realpath, but the loadout-side
# expected body is still the plain canonical).
#
# Reads ONLY `description` and `name` from the frontmatter (TOML schema is
# fixed at 3 keys per TD-021; `tools:` / `model:` / `temperature:` / etc.
# are not part of the codex subagent contract).
#
# Atomic emit (mktemp + mv). Idempotent: same inputs → same bytes. See
# L-519, FR-159.
# ---------------------------------------------------------------------------
assemble_codex_harness_into_loadout() {
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
  # via the out_dir = `<BRAIN_DIR>/loadout/agents/<name>` convention.)
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
# gemini + codex agent targets. Each harness owns its own loadout-resident
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
#            loadout-canonical: same inode = same bytes-on-disk = loadout
#            remains the single physical home.
#
# Claude / Codex branch — 3-case symlink dispatch (FR-152 / FR-159):
#   Case A — target absent → assemble + create symlink → harness.<label>.<ext>.
#   Case B — target IS a symlink → if it resolves to the loadout
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
# `assemble_codex_harness_into_loadout` that emits a 3-key TOML document
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

  local loadout_agent_dir="$BRAIN_DIR/loadout/agents/$name"
  if [ "$harness_label" = "codex" ]; then
    if ! assemble_codex_harness_into_loadout "$name" "$canon_abs" \
                                              "$exc_abs" \
                                              "$loadout_agent_dir"; then
      return 1
    fi
  else
    if ! assemble_agent_harness_into_loadout "$harness_label" "$name" \
                                              "$canon_abs" "$exc_abs" \
                                              "$loadout_agent_dir"; then
      return 1
    fi
  fi
  local harness_target="$loadout_agent_dir/harness.${harness_label}.${harness_ext}"

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
      # TD-434 (2026-08-31): portable file_inode from _common.sh (raw
      # `stat -f %i` returned fs-status text on GNU → the no-op check never
      # matched and every Linux compile re-emitted the hard link).
      tgt_inode=$(file_inode "$target_abs")
      src_inode=$(file_inode "$harness_target")
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
  # must remove the file manually before compile re-creates a loadout-anchored
  # symlink.
  if [ -f "$target_abs" ] && [ ! -L "$target_abs" ]; then
    echo "[$name/$harness_label] ERROR — refuse to clobber non-symlink target: $target_abs (remove manually if it should be a loadout-anchored symlink)" >&2
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
  echo "                          [--surface agents|skills|mcp|hook|all] [--expect-core]" >&2
  echo "" >&2
  echo "Regenerates harness files declared in the manifest from canonical prompts." >&2
  echo "--expect-core: fail LOUDLY (non-zero) if a --expect-core run matches 0" >&2
  echo "               targets (the TD-235 silent-no-op guard). FR-218: core SKILLS" >&2
  echo "               are always (re)projected to the global user store; a non-owner" >&2
  echo "               compile emits a visible WARN, exit 0 — core is never skipped." >&2
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
# FR-180 (TD-235 / D5): when set, the run EXPECTS core surfaces (it was routed
# from `igris add` in core mode, or via an explicit --surface request). An
# ownership-gate skip of a declared core surface then becomes a LOUD FAIL +
# non-zero exit instead of a silent no-op. Default 0 → incidental-compile
# posture (an unrelated personal-project compile emits a single visible
# SKIPPED line and stays exit-0).
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
# FR-217: the valid --target harness set is READ from the canonical descriptor
# (the agents-surface participants) + `all`, instead of the hardcoded
# claude|codex|gemini|opencode case. Byte-identical today (agentTargetTypes() =
# {claude,codex,gemini,opencode}); a new agent harness needs no edit here. Falls
# back to the canonical literals if no descriptor resolves (partial tree).
_target_descriptor="$(resolve_harness_descriptor_path)"
_valid_targets="$(read_harness_descriptor "$_target_descriptor" agent_target_types 2>/dev/null | tr '\n' ' ')"
[ -z "${_valid_targets// /}" ] && _valid_targets="claude codex gemini opencode "
_valid_targets="${_valid_targets}all"
case " $_valid_targets " in
  *" $TARGET_KIND "*) : ;;
  *)
    echo "Error: --target must be one of: ${_valid_targets// /, } (got '$TARGET_KIND')" >&2
    usage
    ;;
esac

# FR-202 (M0): the accepted --surface set is derived from the surface registry
# (IGRIS_SURFACE_IDS in _common.sh) — the ONE membership-gate enforcement point.
# Adding a surface to the registry extends this enum with no edit here. The
# error message lists the registry ids + `all` so it stays in sync automatically.
# (FR-164 mcp, FR-180/D7 hook are all registry entries now.)
if ! igris_surface_is_valid "$SURFACE_KIND"; then
  echo "Error: --surface must be ${IGRIS_SURFACE_IDS// /, }, or all (got '$SURFACE_KIND')" >&2
  usage
fi

# FR-136 overlay resolution: an explicit --overlay wins; otherwise auto-discover
# the personal overlay in the runtime loadout (OPTIONAL - absent is normal).
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
# loadout seam). A name collision between an overlay (personal) agent and a
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
# Process each work row. Accumulators span ALL surface passes (the agents loop
# below and the skills/mcp/hook passes). They are GLOBAL (no bash-3.2
# namerefs) and initialized HERE, before the registry-driven dispatch loop, so
# every project_<surface> plugin shares one set.
# TD-209: REFUSE_TARGETS is the batched refuse-to-clobber collector. Per-target
# functions (compile_md_agent_target Cases C and "other-shape") append the
# offending path here; the post-loop summary emits ONE block instead of N
# per-file ERROR lines. (FR-212d: the skills emit helpers that also wrote here
# were deleted with the custom skills loop.) Global namespace (no `local -n`
# nameref) — required for bash 3.2 (/bin/bash on macOS). Writers MUST avoid
# `local REFUSE_TARGETS` shadowing.
# FR-152: TMPFILES_TO_CLEAN was initialized above the merge step; the EXIT trap
# already references it (loop-pushed inline tempfiles get cleaned on exit).
TOTAL=0
OK=0
FAIL=0
SUMMARY=()
REFUSE_TARGETS=()

# ---------------------------------------------------------------------------
# project_agents — the agents projection surface plugin (FR-202 M0).
# Flattens the manifest into tab-separated work rows via python3:
#   name <TAB> versioned <TAB> canon-dir <TAB> canon-glob-or-file <TAB>
#   body-exception-or-empty <TAB> target-type <TAB> target-path
# One row per agent/target. python3 (no jq) per the _common.sh convention. Then
# dispatches each row to the matching per-target adapter (the inner
# `case "$ttype"` is THIS plugin's projection logic — formats genuinely diverge:
# Claude MD / Gemini MD / OpenCode MD / Codex TOML). Body moved VERBATIM from the
# former inline agents pass; the outer `if SURFACE_KIND = X` gate is now the
# registry dispatch loop (this fn is only called for the agents/all selection).
# Writes the shared global accumulators (TOTAL/OK/FAIL/SUMMARY/REFUSE_TARGETS).
# ---------------------------------------------------------------------------
project_agents() {
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
    # resolution can be keyed on it (core -> in-repo, personal -> loadout).
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
  # under ~/.igris/loadout/<name>/); a relative dir is project-relative. Mirrors
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
      SUMMARY+=("FAIL  $name/$ttype — body-exception sidecar missing: $exc_abs")
      FAIL=$((FAIL + 1))
      continue
    fi
  fi

  # Dispatch to the matching per-target adapter.
  rc=0
  case "$ttype" in
    claude)
      # FR-152 / FR-158: loadout-anchored symlink → assembled
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
      # FR-159: codex now α-projects from the loadout-resident
      # harness.codex.toml (assembled by TS assembleCodexHarness at vendor
      # time, or by compile-side assemble_codex_harness_into_loadout as
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
}

# ---------------------------------------------------------------------------
# project_skills — the skills projection surface plugin (FR-202 M0).
# FR-137: union the skills targets declared in the core surfaces-manifest.json
# with any the merged agent manifest carries, then for each target invoke the
# matching md_to_* compiler/converter (D-4: invoke-from-compiler — the emit
# logic lives in those scripts, unchanged). Body moved VERBATIM from the former
# inline skills pass; the outer `if SURFACE_KIND = skills|all` gate is now the
# registry dispatch loop (this fn is only called for the skills/all selection).
# ---------------------------------------------------------------------------
project_skills() {
  # FR-212a: per-call dedup set for the SKILLS DELEGATE ARM — the distinct
  # source roots already dispatched to `skills add` this run (so the 3 sibling
  # target-type rows per source collapse to a single delegate call). Reset each
  # invocation. Unused on the custom path. Declared with `=()` (bash 3.2-safe).
  DELEGATED_SKILL_ROOTS=()

  # FR-218 (mechanism B): decide whether the GLOBAL core skills source is unioned
  # this run. Under the `skills` CLI delegate, skills placement is global/user-
  # level (no project-local skills dir), so the FR-180 OWNERSHIP gate that dropped
  # core for non-owners is void. But unioning core on EVERY compile would make a
  # `--surface all` agent compile dispatch `skills add <core>` needlessly (and, in
  # an unsandboxed run, touch the real ~/.claude/skills). So core is (re)projected
  # IFF:
  #   (a) the project OWNS core (the igris-ai checkout), OR
  #   (b) the merged (base ++ personal-overlay) manifest carries >=1 skill block
  #       that APPLIES to this --project-root (scope-matched — see
  #       manifest_has_applicable_skill_block). That is the actual PRUNE TRIGGER:
  #       a personal/project `skills add` is what replaces the legacy whole-dir
  #       ~/.claude/skills symlink and detaches the 21 core skills (the
  #       2026-06-30 incident); pairing core with that dispatch re-affirms core.
  #       A scope-FILTERED-OUT block does NOT count — it is not projected here,
  #       so it is not a prune trigger and must NOT pull in core (else a
  #       scoped-out / agent-only `--surface all` compile would `skills add` the
  #       global core source needlessly).
  # When neither holds the skills pass is a NO-OP: no core `skills add`, no
  # skills-CLI dependency, no real-$HOME touch — the safety property. Computed
  # ONCE so the WARN diagnostic and the flatten share ONE decision (§18.1 — the
  # drift sibling computes it identically).
  _core_owned=0
  core_surfaces_owned "$CORE_SURFACES" "$PROJECT_ROOT" && _core_owned=1
  _merged_skill_applies=0
  manifest_has_applicable_skill_block "$MERGED_MANIFEST" "$PROJECT_ROOT" && _merged_skill_applies=1
  _include_core=0
  if [ "$_core_owned" -eq 1 ] || [ "$_merged_skill_applies" -eq 1 ]; then
    _include_core=1
  fi

  # Loud, non-pruning WARN — fires ONLY when a NON-OWNER consumer compile
  # actually (re)projects core to the global store (it carries an applicable
  # personal skill — the prune trigger). Agent-only / scoped-out / no-personal
  # non-owner compiles stay silent no-ops. --expect-core stays the stricter
  # assert via the 0-targets foot-guard.
  if core_skills_declared "$CORE_SURFACES" \
     && [ "$_core_owned" -eq 0 ] \
     && [ "$_merged_skill_applies" -eq 1 ]; then
    echo "WARN  core skills are (re)projected to the GLOBAL user store from non-owner --project-root $PROJECT_ROOT (skills are global; no project-local skills dir; FR-218)" >&2
  fi

  # Flatten skills targets from both sources into rows:
  #   source <TAB> type <TAB> method <TAB> path <TAB> scope_type <TAB> scope_paths
  # `-` is the empty-source / empty-paths sentinel (caller falls back to md_to_*'s
  # default; scope_paths="-" means scope=global so no project-root match needed).
  # FR-155: scope_type+scope_paths appended at the END so any downstream parser
  # reading only the first 4 columns stays back-compat with the pre-FR-155 shape.
  SKILL_ROWS=$(python3 - "$CORE_SURFACES" "$MERGED_MANIFEST" "$TARGET_KIND" "$_include_core" <<'PY'
import json
import sys

core_surfaces_path = sys.argv[1]
agent_manifest_path = sys.argv[2]
target_kind = sys.argv[3]
include_core = sys.argv[4] == "1"


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


# FR-218 (mechanism B): the core surfaces-manifest.json source is unioned IFF
# `include_core` (computed by the bash caller: the project OWNS core OR the
# merged manifest carries >=1 skill block — the prune trigger). When false
# (agent-only / no-personal compile) the skills pass is a no-op. Core first,
# then the merged (base ++ personal-overlay) manifest. A missing/unreadable core
# source simply contributes no rows (load_skills swallows OSError).
sources = ([core_surfaces_path] if include_core else []) + [agent_manifest_path]

# TD-191 / BR-074: NO `seen_paths` dedup here. The merge guard only rejects
# personal roots that shadow core roots; sibling personal blocks may share a
# consumer root such as ~/.agents/skills because the compiler emits distinct
# per-skill children below that root. Keeping a dedup here would silently drop
# one of those legitimate personal skill rows.
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

      # FR-212d Phase 2: SKILLS DELEGATE DISPATCH (the ONLY skills engine now —
      # the custom inline symlink/wrapper loop was DELETED after the 5-harness
      # smoke gate went green). Shell out to the `skills` CLI via `igris loadout
      # project-skills --source <root>` (the LOCAL pinned binary, resolved inside
      # the TS delegate — NEVER a bare `npx`). The tool's `skills add <root>`
      # projects EVERY skill under the root to all Igris harnesses in ONE call, so we
      # dispatch ONCE per distinct source root (the 3 per-source target-type rows
      # — claude/agents/opencode — collapse to a single call; DELEGATED_SKILL_ROOTS
      # dedups). Mirrors how project_mcp/project_hook shell to the loadout verb
      # (§18.1: bash never re-implements placement). NO custom fallback (constraint
      # #2): a tool FAIL is an observable counted FAIL.
      #
      # Resolve the source root the tool projects from. `-` (no source row)
      # → the loadout-skills default `~/.igris/core/skills`.
      delegate_root="${src_abs:-$HOME/.igris/core/skills}"
      # Dedup: only the FIRST row for a given root dispatches + counts. Later
      # rows for the same root (the sibling target-type entries) are folded in
      # (TOTAL was already incremented for them above — decrement to keep the
      # count one-per-projected-root, matching the single delegate invocation).
      already_delegated=0
      # bash 3.2 + `set -u`: iterating an EMPTY array via "${arr[@]}" throws
      # "unbound variable" (the first row hits this — DELEGATED_SKILL_ROOTS is
      # empty). The `${arr[@]+"${arr[@]}"}` guard expands to nothing when the
      # array is unset/empty, so the loop body simply never runs.
      for _r in ${DELEGATED_SKILL_ROOTS[@]+"${DELEGATED_SKILL_ROOTS[@]}"}; do
        if [ "$_r" = "$delegate_root" ]; then already_delegated=1; break; fi
      done
      if [ "$already_delegated" -eq 1 ]; then
        TOTAL=$((TOTAL - 1))
        continue
      fi
      DELEGATED_SKILL_ROOTS+=("$delegate_root")
      rc=0
      "${IGRIS_CLI_CMD[@]}" loadout project-skills \
        --source "$delegate_root" \
        --project-root "$PROJECT_ROOT" \
        ${OVERLAY:+--overlay "$OVERLAY"} || rc=$?
      if [ "$rc" -eq 0 ]; then
        SUMMARY+=("OK    skills (delegate) -> $delegate_root")
        OK=$((OK + 1))
      else
        # Observable FAIL (L-232): the delegate verb already named the failure
        # on stderr (binary-not-local / tool exit). Never a silent no-op.
        SUMMARY+=("FAIL  skills (delegate) — loadout project-skills exited $rc")
        FAIL=$((FAIL + 1))
      fi
      done <<< "$SKILL_ROWS"
  fi
}

# ---------------------------------------------------------------------------
# project_mcp — the MCP-server projection surface plugin (FR-202 M0).
# FR-164 (FR-160 epic): for each (mcp-block,target) row, dispatch to the TS
# projector (`igris loadout project-mcp`) which builds the native per-harness
# entry and MERGES it into the live harness config via the proven
# mergeJsonConfig/mergeTomlConfig (§18.1: bash NEVER re-implements the merge —
# this pass is a thin driver + accounting). Each invocation writes ONE config; we
# count OK/FAIL per (mcp,target) into the shared accumulators.
#
# SECRET HYGIENE: the row carries the ${VAR} REFERENCE in `canonical_json`, NOT
# a resolved literal. The codex literal is resolved only INSIDE the projector
# (from secrets.env), never in a bash variable that could be `set -x`'d. We
# NEVER echo `canonical_json`. The projector itself prints only the outcome +
# name + harness (no env values).
#
# Body moved VERBATIM from the former inline MCP pass; the outer
# `if SURFACE_KIND = mcp|all` gate is now the registry dispatch loop.
# ---------------------------------------------------------------------------
project_mcp() {
  # FR-212d: the MCP engine is now a CONSTANT "delegate" (igris_mcp_engine; the
  # IGRIS_MCP_ENGINE env read was RETIRED). The TS `igris loadout project-mcp`
  # shells to `add-mcp` for SERVER REGISTRATION then writes the Igris-owned
  # no-prompt GRANT (mcp-grant.ts) for the delegated harnesses; antigravity's
  # ENTRY stays custom INSIDE the TS (FR-179 config/ path) but its grant is still
  # written. The per-row dispatch below is engine-agnostic (bash never
  # re-implements placement — §18.1). We resolve the constant ONCE for the
  # summary label only.
  local mcp_engine
  mcp_engine="$(igris_mcp_engine)"
  MCP_ROWS=$(flatten_mcp_rows "$MERGED_MANIFEST" "$CORE_SURFACES" "$TARGET_KIND" "$PROJECT_ROOT")
  if [ -n "$MCP_ROWS" ]; then
    # TD-390-GUARD-BEGIN
    # TD-390: IGRIS_MCP_<HARNESS>_CONFIG is the READ-ONLY drift seam (the
    # verify_mcp `case` in check_harness_drift.sh + the MAINTAINING.md row).
    # Every writer below resolves its config from $HOME — add-mcp (module-load
    # homedir(), no path flag), paths.ts, the grant — so a seam-set compile
    # would write the LIVE harness config (the TD-388 fixture incident). Refuse
    # the pass, loudly; a sandboxed WRITE is an isolated HOME. `*_CONFIG` only:
    # IGRIS_MCP_ENGINE is the retired engine knob (fr212-smoke still exports
    # it), not a seam. An empty value is unset (mirrors the reader's
    # ${VAR:-default}). bash 3.2: prefix expansion, no declare -A.
    # Scoped HERE (non-empty MCP_ROWS) so `--surface agents` and an agents-only
    # manifest never trip it. Pinned by test/harness_mcp_seam_guard.test.bash.
    local seam_var="" _v
    for _v in "${!IGRIS_MCP_@}"; do
      case "$_v" in
        *_CONFIG) if [ -n "${!_v:-}" ]; then seam_var="$_v"; break; fi ;;
      esac
    done
    if [ -n "$seam_var" ]; then
      echo "ERROR: compile_harnesses.sh refuses the MCP pass: $seam_var is set, but IGRIS_MCP_*_CONFIG redirects only the drift READER (check_harness_drift.sh). The writer (igris loadout project-mcp -> add-mcp + grant) resolves its config from \$HOME and would write the live harness config. To sandbox a compile, run it under an isolated HOME and unset the seam. (TD-390)" >&2
    fi
    # TD-390-GUARD-END
    while IFS=$'\t' read -r m_name m_canon m_type m_enabled m_scope_type m_scope_paths; do
      [ -z "$m_name" ] && continue
      [ -z "$m_type" ] && continue

      # FR-180 (S1): honor --filter on the MCP surface (parity with the skills +
      # agent surfaces). `igris add mcp` passes --filter <name> so the verify
      # half (drift check, which has no --surface flag) is scoped to the
      # just-added MCP server — a pre-existing UNRELATED MCP drift can't false-
      # fail a clean add. Default FILTER='*' keeps the full-compile behavior.
      # Runs BEFORE TOTAL++ so the summary count is filter-aware (parity with
      # the skills loop). The drift side (check_harness_drift.sh) mirrors this.
      skill_name_matches_filter "$m_name" "$FILTER" || continue

      # v1 is GLOBAL-ONLY; scope columns are carried for forward-compat but
      # every block is treated as global (no project-scope filter here, unlike
      # skills). m_canon/m_scope_* are intentionally NOT echoed (m_canon holds
      # the ${VAR} ref).
      : "$m_scope_type" "$m_scope_paths"

      TOTAL=$((TOTAL + 1))

      # TD-390-ROW-BEGIN
      # TD-390: a counted FAIL row per target (parser-coupled `FAIL  ` prefix,
      # parseHarnessOutput needs no re-point) + the exit-1 gate below. The
      # `continue` is the guard — without it the dispatch still runs.
      if [ -n "$seam_var" ]; then
        SUMMARY+=("FAIL  mcp/$m_name/$m_type — refused: $seam_var is set (read-only drift seam; TD-390)")
        FAIL=$((FAIL + 1))
        continue
      fi
      # TD-390-ROW-END

      # Dispatch to the TS projector. ONE harness per call. The projector reads
      # the SAME merged manifest (base ++ overlay) via --project-root/--overlay,
      # finds the named block, and writes the native shape atomically. Its
      # stdout/stderr passes through (the projector never prints a secret).
      rc=0
      "${IGRIS_CLI_CMD[@]}" loadout project-mcp \
        --name "$m_name" \
        --harness "$m_type" \
        --project-root "$PROJECT_ROOT" \
        ${OVERLAY:+--overlay "$OVERLAY"} || rc=$?

      if [ "$rc" -eq 0 ]; then
        # FR-212d: tag the engine in the summary (always "delegate" now =
        # add-mcp + grant for the delegated harnesses; antigravity's entry is
        # custom-written inside the TS but tagged the same). The label is purely
        # informational — the placement is the TS verb's job.
        SUMMARY+=("OK    mcp/$m_name/$m_type ($mcp_engine)")
        OK=$((OK + 1))
      else
        # Observable FAIL (L-232): a real exit code + a counted FAIL row, never
        # a silent empty success. The projector already named the failure on
        # stderr (block-not-found / missing-secret VAR name / merge/grant error).
        SUMMARY+=("FAIL  mcp/$m_name/$m_type ($mcp_engine) — projector exited $rc")
        FAIL=$((FAIL + 1))
      fi
    done <<< "$MCP_ROWS"
  fi
}

# ---------------------------------------------------------------------------
# project_hook — the event-hook projection surface plugin (FR-202 M0).
# FR-180 (D7 - Option B): for each (hook-block, target) row, dispatch to the TS
# projector (`igris loadout project-hook`), which MERGES the hook GROUP into the
# harness's native hook surface (claude → .claude/settings.json hooks array;
# opencode → covered by the FR-104 plugin). §18.1: bash NEVER re-implements the
# merge — this pass is a thin driver + accounting. ONE config per call; OK/FAIL
# counted per (hook,target) into the shared accumulators. The command path is a
# SCRIPT path the harness runs (never a secret) — the personal loadout-prefix
# path is what the canonical re-merge preserves (R2). Honors --filter (S1) for
# the scoped verify.
#
# Body moved VERBATIM from the former inline hook pass; the outer
# `if SURFACE_KIND = hook|all` gate is now the registry dispatch loop.
# ---------------------------------------------------------------------------
project_hook() {
  HOOK_ROWS=$(flatten_hook_rows "$MERGED_MANIFEST" "$CORE_SURFACES" "$TARGET_KIND" "$PROJECT_ROOT")
  if [ -n "$HOOK_ROWS" ]; then
    while IFS=$'\t' read -r h_name h_event h_command h_matcher h_timeout h_type h_enabled h_layer h_scope_type h_scope_paths; do
      [ -z "$h_name" ] && continue
      [ -z "$h_type" ] && continue

      # FR-180 (S1): honor --filter (parity with the mcp/skills surfaces) so the
      # scoped verify re-checks only the just-added hook. Runs BEFORE TOTAL++.
      skill_name_matches_filter "$h_name" "$FILTER" || continue

      # v1 GLOBAL-ONLY; scope/layer/matcher/timeout carried by the row but the
      # projector reads them from the merged manifest, not echoed here.
      : "$h_event" "$h_command" "$h_matcher" "$h_timeout" "$h_enabled" \
        "$h_layer" "$h_scope_type" "$h_scope_paths"

      TOTAL=$((TOTAL + 1))

      rc=0
      "${IGRIS_CLI_CMD[@]}" loadout project-hook \
        --name "$h_name" \
        --harness "$h_type" \
        --project-root "$PROJECT_ROOT" \
        ${OVERLAY:+--overlay "$OVERLAY"} || rc=$?

      if [ "$rc" -eq 0 ]; then
        SUMMARY+=("OK    hook/$h_name/$h_type")
        OK=$((OK + 1))
      else
        SUMMARY+=("FAIL  hook/$h_name/$h_type — projector exited $rc")
        FAIL=$((FAIL + 1))
      fi
    done <<< "$HOOK_ROWS"
  fi
}

# ---------------------------------------------------------------------------
# FR-202 (M0): surface-agnostic dispatch. Iterate the surface registry
# (IGRIS_SURFACE_IDS in _common.sh, in projection order) and run each surface's
# project_<surface> plugin when the --surface selection includes it (or `all`).
# This SINGLE loop replaces the five former inline `if SURFACE_KIND = X` pass-
# gates — adding a surface is a registry entry + a project_<surface> plugin,
# ZERO edit here. Plugins are called as PLAIN statements (never in a condition)
# so `set -e` stays active inside them exactly as in the former top-level passes.
# Accumulators (TOTAL/OK/FAIL/SUMMARY/REFUSE_TARGETS) are global, shared across
# plugins (bash 3.2 has no namerefs).
# ---------------------------------------------------------------------------
for _surface in $IGRIS_SURFACE_IDS; do
  if igris_surface_selected "$_surface" "$SURFACE_KIND"; then
    "project_$_surface"
  fi
done

if [ "$TOTAL" -eq 0 ]; then
  # FR-202 (M0): the surface noun list is derived from the registry
  # (IGRIS_SURFACE_LABELS) so a new surface extends it automatically. The
  # rendered string is now "No agent/skills/mcp/hook targets matched …"
  # (FR-202 M4 dropped the identity surface; parser-coupled — parseHarnessOutput
  # reads "… targets matched").
  echo "No $(igris_surface_empty_match_nouns) targets matched (filter='$FILTER', target='$TARGET_KIND', surface='$SURFACE_KIND')." >&2
  # FR-180 (TD-235 / D5): a 0-target run under --expect-core is the silent
  # no-op the brief forbids — the caller (igris add) routed this expecting core
  # surfaces and got nothing. Fail LOUDLY so add can surface an actionable
  # message instead of reporting a phantom success. Without --expect-core
  # (incidental compile / legacy callers) the historical exit-0 is preserved.
  if [ "$EXPECT_CORE" -eq 1 ]; then
    echo "FAIL  core surfaces — 0 targets matched under --expect-core for --project-root $PROJECT_ROOT; run from the igris-ai repo or pass --core" >&2
    exit 1
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Summary report.
#
# PARSER↔ADAPTER COUPLING (FR-180 / FR-218): the per-row `OK …` / `FAIL …`
# prefixes emitted here — plus the "… targets matched" empty-match line and the
# "WARN  core skills …" non-owner diagnostic above (FR-218: was the retired
# "SKIPPED core surfaces …" line) — are parsed by `parseHarnessOutput` in
# cli/src/verbs/harness.ts (the structured path that `igris add` relies on). If
# you change these literals, update that parser in the SAME change (there is a
# matching breadcrumb comment there).
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
