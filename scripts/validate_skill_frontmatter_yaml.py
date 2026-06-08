#!/usr/bin/env python3
"""
validate_skill_frontmatter_yaml.py

Validates that every SKILL.md frontmatter block parses under a STRICT YAML
parser (PyYAML's `yaml.safe_load`). Lenient harnesses (Claude, Gemini)
tolerate an unquoted mid-scalar `: ` (e.g. `description: Foo - usage: /bar`),
but strict parsers (Codex) read the second `: ` as a nested mapping and
reject the file — SILENTLY SKIPPING the skill. This guard is the recurrence
gate for that class of bug.

Scope: the frontmatter block ONLY (text strictly between the leading `---`
fence and the next `---`), not the markdown body. PyYAML's error class for
this input is the same `mapping values are not allowed` message Codex logs,
making it a faithful proxy.

Discovers:
  - repo `core/skills/*/SKILL.md` (canonical sources, ALWAYS).
  - repo `core/skills-dev/*/SKILL.md` (TD-224 framework-dev skills, ALWAYS).
  - `~/.igris/registry/skills/*/*/SKILL.md` (vendored) IF that dir exists —
    best-effort, gated on existence so CI stays hermetic.
  - SKILL_GLOB env override (one or more glob patterns, `:`-separated) to
    point the validator at a fixture dir (used by the bats recurrence test).
    When set, it REPLACES the default discovery set.

Usage:
    python3 scripts/validate_skill_frontmatter_yaml.py
    SKILL_GLOB="/tmp/fixtures/*/SKILL.md" python3 scripts/validate_skill_frontmatter_yaml.py

Exit codes:
    0 - All discovered SKILL.md frontmatter blocks parse under strict YAML
    1 - One or more frontmatter blocks failed strict parse (recurrence)
    2 - Setup error (PyYAML missing, no SKILL.md found, unreadable file)

See: learning #587, TD-219.
"""
from __future__ import annotations
import glob
import os
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
CORE_SKILLS_GLOB = str(REPO_ROOT / "core" / "skills" / "*" / "SKILL.md")
# TD-224: framework-dev skills (project-scoped to the igris-ai repo) live in
# core/skills-dev/ — they MUST stay covered by the strict-YAML gate too, or a
# relocated skill silently escapes the validator (a regression).
DEV_SKILLS_GLOB = str(REPO_ROOT / "core" / "skills-dev" / "*" / "SKILL.md")
REGISTRY_SKILLS_GLOB = str(
    pathlib.Path.home() / ".igris" / "registry" / "skills" / "*" / "*" / "SKILL.md"
)


def discover() -> list[pathlib.Path]:
    """Return the sorted, de-duplicated set of SKILL.md files to validate."""
    override = os.environ.get("SKILL_GLOB")
    if override:
        patterns = [p for p in override.split(":") if p]
    else:
        patterns = [CORE_SKILLS_GLOB, DEV_SKILLS_GLOB]
        # Best-effort vendored scan only when the machine-local dir exists,
        # so CI never depends on a path outside the repo.
        if pathlib.Path(REGISTRY_SKILLS_GLOB).parent.parent.exists():
            patterns.append(REGISTRY_SKILLS_GLOB)

    found: set[str] = set()
    for pat in patterns:
        found.update(glob.glob(pat))
    return sorted(pathlib.Path(p) for p in found)


def extract_frontmatter(text: str) -> str | None:
    """Return the text strictly between the leading `---` and the next `---`.

    Returns None if the file has no leading frontmatter fence (no block to
    validate — not an error, just nothing to parse).
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i])
    # Leading fence with no closing fence: treat as the rest of the file.
    return "\n".join(lines[1:])


def main() -> int:
    try:
        import yaml  # noqa: WPS433 (runtime import so we can exit 2 cleanly)
    except ImportError:
        print(
            "Error: PyYAML is required but not importable.\n"
            "  Install it with: python3 -m pip install pyyaml\n"
            "  (The validator uses a strict YAML parser to mirror Codex's "
            "skill loader; it must NOT silently pass without it.)"
        )
        return 2

    files = discover()
    if not files:
        print(
            "Error: no SKILL.md files found to validate.\n"
            f"  Default scope: {CORE_SKILLS_GLOB}\n"
            "  (Set SKILL_GLOB to point at a fixture dir, or run from the repo root.)"
        )
        return 2

    failures: list[str] = []
    for path in files:
        try:
            text = path.read_text()
        except OSError as exc:
            print(f"Error: cannot read {path}: {exc}")
            return 2

        fm = extract_frontmatter(text)
        if fm is None:
            # No frontmatter block — nothing for the strict parser to choke on.
            continue

        try:
            yaml.safe_load(fm)
        except yaml.YAMLError as exc:
            mark = ""
            problem_mark = getattr(exc, "problem_mark", None)
            if problem_mark is not None:
                mark = f" (line {problem_mark.line + 1}, col {problem_mark.column + 1})"
            msg = str(exc).splitlines()[0] if str(exc) else exc.__class__.__name__
            failures.append(f"{path}{mark}: {msg}")

    if failures:
        print("SKILL.md frontmatter failed STRICT YAML parse (TD-219, #587):")
        for fail in failures:
            print(f"  - {fail}")
        print(
            "\nFix: double-quote any frontmatter scalar containing a mid-value "
            "`: ` (colon-space)\n"
            '     e.g. description: "Archive a brief - usage: /archive BR-008"\n'
            "     Strict parsers (Codex) read the 2nd `: ` as a nested mapping "
            "and SILENTLY skip the skill."
        )
        return 1

    print(f"OK: {len(files)} SKILL.md frontmatter blocks parse under strict YAML")
    return 0


if __name__ == "__main__":
    sys.exit(main())
