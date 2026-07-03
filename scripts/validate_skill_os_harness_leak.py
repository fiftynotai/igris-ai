#!/usr/bin/env python3
"""
validate_skill_os_harness_leak.py

Recurrence net for HARNESS LEAKS in skills and the OS core (TD-248).

Skills and the OS core (`core/os/*.md`, `core/prompts/*.md`) must name only
ABSTRACT intents, never harness-specific branches. A harness-specific branch
is one that hardcodes a single harness's env var, flag, per-harness config
path, or runtime-subagent API as the way to do something — instead of
delegating through the harness-agnostic adapter boundary. When such a branch
leaks into a skill or OS doc, the behavior silently breaks (or silently
no-ops) on every other harness. TD-244 / TD-247 are the cautionary tales.

This guard flags the KNOWN high-confidence leak token classes:
  - harness experimental/behavior flags: `CLAUDE_CODE_*`
  - per-harness config paths used as a read/WRITE TARGET:
      `.claude/agents/`, `.claude/settings.json`, `~/.gemini/`,
      `~/.config/opencode/`, `.codex/`
  - runtime-subagent APIs: `define_subagent` / `invoke_subagent`
    (the FR-183 recipe class — must stay relocated to the identity surface).

It is CONSERVATIVE BY DESIGN (L-400). It is a recurrence net for the known
token classes, NOT a proof of zero leaks: it will catch a new `.claude/`-path
instruction or a new `CLAUDE_CODE_*` flag, but it will NOT catch a novel
harness behavior expressed in fresh vocabulary. When a hit is ambiguous the
lint does NOT flag — under-flagging is recoverable, over-flagging erodes trust
and trains `--no-verify` habits.

What it deliberately does NOT flag:
  - `subagent_type` — the harness-AGNOSTIC delegation CONTRACT (the Agent-tool
    interface every harness resolves; OK1). Never a leak.
  - `CLAUDE_PROJECT_DIR` — formerly carried the per-skill `### 0. Track
    Invocation` telemetry block (removed in FR-202 M7; portable restore tracked
    in TD-260). The token may still appear in skills for legitimate
    project-slug resolution (e.g. `visualize/SKILL.md`) — a graceful-degradation
    env read, not a harness branch, so it stays exempted here.
  - bare doc MENTIONS in prose — a token in a sentence describing the adapter
    mechanism (e.g. "the MCP server is registered in ~/.claude.json") is not a
    branch. Only EXECUTABLE / INSTRUCTION lines count (a fenced ```bash block,
    or a line with an imperative verb that targets the path).
  - the disclaimed brand word "Claude" in identity/voice prose
    (e.g. "You ARE Igris AI — not Claude using Igris AI").

Allowlist (explicit, commented constant — L-448):
  - core/skills/onboard-harness/SKILL.md — the adapter-AUTHORING guide;
    harness-specific knowledge is its entire purpose (TD-248 OK2).
  - core/os/surfaces-detail.md — documents the adapter boundary itself;
    naming the harnesses is its job (TD-248 OK3).
  - core/skills/team/SKILL.md — declared single-harness: Agent-Teams is a
    Claude-Code-native capability, so /team is intentionally Claude-only — NOT
    a leak to remove (FR-202 M6). Permanently allowlisted by design; this is a
    declared-single-harness exemption, not a deferral awaiting TD-247.

Discovers:
  - repo `core/skills/*/SKILL.md` + `core/os/*.md` + `core/prompts/*.md`.
  - LEAK_SCAN_GLOB env override (one or more glob patterns, `:`-separated) to
    point the lint at a fixture dir (used by the bats recurrence test). When
    set, it REPLACES the default discovery set.

Usage:
    python3 scripts/validate_skill_os_harness_leak.py
    LEAK_SCAN_GLOB="/tmp/fix/*/SKILL.md" python3 scripts/validate_skill_os_harness_leak.py

Exit codes:
    0 - No harness leak found in the (non-allowlisted) scan set
    1 - One or more genuine harness leaks found (recurrence)
    2 - Setup error (no files found, unreadable file)

See: TD-248, learnings L-400 (recurrence-net scope honesty),
     L-448 (validator + explicit allowlist makes the drift class structurally
     preventable), TD-244 / TD-247 (the leaks this guards against).
"""
from __future__ import annotations

import glob
import os
import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_GLOBS = (
    str(REPO_ROOT / "core" / "skills" / "*" / "SKILL.md"),
    str(REPO_ROOT / "core" / "os" / "*.md"),
    str(REPO_ROOT / "core" / "prompts" / "*.md"),
)

# --- Allowlist (explicit constant — L-448) -----------------------------------
# Files where harness-specific tokens are BY DESIGN or are a known-deferred
# leak tracked elsewhere. Matched by basename-suffix against the repo-relative
# path so the bats fixture (which lives under a temp dir) can reproduce the
# allowlist by mirroring the trailing path. See module docstring for the
# per-file rationale (TD-248 OK2/OK3 + the L1/L2/L4 deferrals).
ALLOWLIST_SUFFIXES = (
    "core/skills/onboard-harness/SKILL.md",   # adapter-authoring guide (OK2)
    "core/os/surfaces-detail.md",             # documents the adapter boundary (OK3)
    "core/skills/team/SKILL.md",              # declared single-harness: Claude-native Agent-Teams (FR-202 M6) — intentional, not a leak
)
# FR-187: core/prompts/igris_os.md was deleted (the monolith retired; its
# go-forward home is the scanned core/os/ layer), so its former allowlist
# entry + the L1 -> TD-247 deferral were removed — the file no longer exists
# to scan or exempt.

# --- Leak token classes (the known high-confidence set) ----------------------
# Each entry: (compiled-pattern, human label). A line matches a leak only when
# it ALSO looks like an instruction (see line_is_instruction). The patterns are
# deliberately narrow; widening them is a conscious decision, not an accident.

# A harness experimental/behavior flag (CLAUDE_CODE_*). Always a behavior gate.
RE_HARNESS_FLAG = re.compile(r"\bCLAUDE_CODE_[A-Z0-9_]+\b")

# Runtime-subagent APIs (the FR-183 recipe class). subagent_type is NOT here.
RE_SUBAGENT_API = re.compile(r"\b(?:define_subagent|invoke_subagent)\b")

# Per-harness config paths used as a target. Match the path token itself; the
# instruction check below decides whether the line is a real read/write/count.
RE_HARNESS_PATH = re.compile(
    r"(?:"
    r"\.claude/agents/"          # Claude agent dir
    r"|\.claude/settings\.json"  # Claude settings
    r"|~/\.gemini/"              # Gemini config root
    r"|~/\.config/opencode/"     # OpenCode config root
    r"|~/\.codex/"               # Codex config root (home-anchored — TD-248 warden M1)
    r"|(?:^|[^A-Za-z0-9_./])\.codex/"  # Codex config dir, relative (not mid-identifier)
    r")"
)

# Imperative verbs that turn a path mention into an instruction TARGET. The
# token must co-occur with one of these (or be inside a code fence) to count.
INSTRUCTION_VERBS = re.compile(
    r"\b(?:bash|sh|cat|ls|read|count|create|delete|remove|write|set|add|edit|"
    r"open|touch|mkdir|cp|mv|rm|echo)\b",
    re.IGNORECASE,
)
# Redirection / glob-ish shapes that also signal an instruction target.
INSTRUCTION_SHAPE = re.compile(r"(?:[<>]|\*\.md|\bfiles\b)")


def discover() -> list[pathlib.Path]:
    """Return the sorted, de-duplicated set of files to scan."""
    override = os.environ.get("LEAK_SCAN_GLOB")
    if override:
        patterns = [p for p in override.split(":") if p]
    else:
        patterns = list(DEFAULT_GLOBS)

    found: set[str] = set()
    for pat in patterns:
        found.update(glob.glob(pat))
    return sorted(pathlib.Path(p) for p in found)


def is_allowlisted(path: pathlib.Path) -> bool:
    """True if the path ends with an allowlisted repo-relative suffix."""
    posix = path.as_posix()
    return any(posix.endswith(suffix) for suffix in ALLOWLIST_SUFFIXES)


def iter_code_fence_lines(lines: list[str]) -> set[int]:
    """Return the 0-based indices of lines INSIDE a ``` code fence.

    A leak token inside a fenced block is treated as an executable
    instruction regardless of surrounding verbs (the branch-vs-mention
    heuristic, §4.2): code fences carry commands/config, prose does not.
    """
    inside: set[int] = set()
    in_fence = False
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):  # CommonMark backtick + tilde fences (TD-248 warden m3)
            in_fence = not in_fence
            continue  # the fence delimiter line itself is not "inside"
        if in_fence:
            inside.add(i)
    return inside


def line_is_instruction(line: str, in_fence: bool) -> bool:
    """A line counts as an instruction (vs a bare prose mention) when it is
    inside a code fence OR carries an imperative verb / redirect / glob shape.

    This is the branch-vs-mention guard (§4.2). A token sitting in a sentence
    that merely describes the adapter mechanism (OK5/OK6) is NOT an
    instruction and is not flagged.
    """
    if in_fence:
        return True
    return bool(INSTRUCTION_VERBS.search(line) or INSTRUCTION_SHAPE.search(line))


def scan_file(path: pathlib.Path) -> list[str]:
    """Return a list of leak findings ('path:line: <label> -> <line text>')."""
    text = path.read_text()
    lines = text.splitlines()
    fence_lines = iter_code_fence_lines(lines)
    findings: list[str] = []

    for idx, line in enumerate(lines):
        in_fence = idx in fence_lines

        # Flag classes that are ALWAYS a behavior gate wherever they appear as
        # an instruction (flags + runtime-subagent APIs).
        flag_hit = RE_HARNESS_FLAG.search(line)
        api_hit = RE_SUBAGENT_API.search(line)
        path_hit = RE_HARNESS_PATH.search(line)

        if not (flag_hit or api_hit or path_hit):
            continue

        if not line_is_instruction(line, in_fence):
            # Bare prose mention (OK5/OK6) — conservative skip.
            continue

        label = []
        if flag_hit:
            label.append(f"harness flag `{flag_hit.group(0)}`")
        if api_hit:
            label.append(f"runtime-subagent API `{api_hit.group(0)}`")
        if path_hit:
            label.append(f"per-harness path `{path_hit.group(0).strip()}`")

        snippet = line.strip()
        if len(snippet) > 120:
            snippet = snippet[:117] + "..."
        findings.append(
            f"{path}:{idx + 1}: {', '.join(label)}  ->  {snippet}"
        )

    return findings


def main() -> int:
    files = discover()
    if not files:
        print(
            "Error: no skill/OS files found to scan.\n"
            f"  Default scope: {', '.join(DEFAULT_GLOBS)}\n"
            "  (Set LEAK_SCAN_GLOB to point at a fixture dir, or run from the repo root.)"
        )
        return 2

    scanned = 0
    skipped = 0
    all_findings: list[str] = []
    for path in files:
        if is_allowlisted(path):
            skipped += 1
            continue
        try:
            findings = scan_file(path)
        except OSError as exc:
            print(f"Error: cannot read {path}: {exc}")
            return 2
        scanned += 1
        all_findings.extend(findings)

    if all_findings:
        print("Harness leak detected in skill/OS core (TD-248):")
        for finding in all_findings:
            print(f"  - {finding}")
        print(
            "\nSkills and the OS core must name only ABSTRACT intents, never a\n"
            "harness-specific branch. Route harness-specific behavior through the\n"
            "adapter boundary (the per-harness dir/flag is adapter-owned), or — if\n"
            "the file legitimately documents the adapter itself — add it to the\n"
            "explicit allowlist in scripts/validate_skill_os_harness_leak.py with a\n"
            "rationale comment. Do NOT broaden the allowlist to launder a real leak."
        )
        return 1

    print(
        f"OK: scanned {scanned} skill/OS files (+{skipped} allowlisted) — "
        "no harness leak"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
