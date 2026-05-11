#!/usr/bin/env python3
"""
validate_igris_tree_lineranges.py

Validates that every section declared in `core/igris_tree.json` has a
matching `<!-- SECTION: <name> -->` marker at the declared start line and
a `<!-- /SECTION: <name> -->` marker at the declared end line in the
referenced source file (currently `core/prompts/igris_os.md`).

Catches drift between the routing tree and the prompt body when the prompt
is edited but the tree's line ranges are not (DRIFT-3, TD-070).

Usage:
    python3 scripts/validate_igris_tree_lineranges.py

Exit codes:
    0 - All section line ranges match markers in source
    1 - One or more mismatches (drift detected)
    2 - Tree/source file missing or unparseable
"""
from __future__ import annotations
import json
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
TREE_PATH = REPO_ROOT / "core" / "igris_tree.json"
PROMPT_PATH = REPO_ROOT / "core" / "prompts" / "igris_os.md"


def main() -> int:
    if not TREE_PATH.exists():
        print(f"Error: tree file not found: {TREE_PATH}")
        return 2
    if not PROMPT_PATH.exists():
        print(f"Error: prompt file not found: {PROMPT_PATH}")
        return 2

    try:
        tree = json.loads(TREE_PATH.read_text())
    except json.JSONDecodeError as e:
        print(f"Error: igris_tree.json failed to parse: {e}")
        return 2

    try:
        sections = tree["context_files"]["igris_os"]["sections"]
    except KeyError:
        print("Error: tree missing context_files.igris_os.sections")
        return 2

    lines = PROMPT_PATH.read_text().splitlines()
    errors: list[str] = []

    for name, meta in sections.items():
        rng = meta.get("lines", "")
        try:
            start_str, end_str = rng.split("-")
            start, end = int(start_str), int(end_str)
        except (ValueError, AttributeError):
            errors.append(f"{name}: malformed lines range {rng!r}")
            continue

        if start < 1 or end > len(lines) or start > end:
            errors.append(
                f"{name}: range {start}-{end} out of bounds (file has {len(lines)} lines)"
            )
            continue

        start_line = lines[start - 1]
        end_line = lines[end - 1]
        expected_open = f"<!-- SECTION: {name} -->"
        expected_close = f"<!-- /SECTION: {name} -->"

        if expected_open not in start_line:
            errors.append(
                f"{name}: expected {expected_open!r} at line {start}, "
                f"found {start_line!r}"
            )
        if expected_close not in end_line:
            errors.append(
                f"{name}: expected {expected_close!r} at line {end}, "
                f"found {end_line!r}"
            )

    if errors:
        print("igris_tree.json line-range drift (DRIFT-3, TD-070):")
        for err in errors:
            print(f"  - {err}")
        print(
            "\nFix: re-run `grep -n '<!-- SECTION:' core/prompts/igris_os.md`"
            "\n     and update the `lines` fields in core/igris_tree.json"
            "\n     (remember to mirror to ~/.igris/core/igris_tree.json)"
        )
        return 1

    print(f"OK: all {len(sections)} section line-ranges match markers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
